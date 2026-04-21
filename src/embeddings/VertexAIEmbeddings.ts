import type { EmbeddingFunction } from "../types.js";
import {
  charBudgetBatches,
  fetchWithRetry,
  l2Normalize,
  mapWithConcurrency,
  prepareTexts,
  reassembleVectors,
} from "./utils.js";
import { type VertexAuthOptions, getVertexAccessToken } from "./vertexAuth.js";

type VertexModelCaps = {
  nativeDim: number;
  /** Default output dimensionality when the user does not pass `dimensions` explicitly. */
  defaultDim: number;
  /**
   * Max input items per :predict request. `text-embedding-*` allow up to 250;
   * `gemini-embedding-001` requires one input per request (no server-side
   * batching).
   */
  maxBatchItems: number;
  /**
   * Default number of concurrent :predict requests. Picked to stay under the
   * published default RPM quotas for each model; override via the
   * `concurrency` constructor option if your project quota is higher/lower.
   */
  defaultConcurrency: number;
};

const MODEL_CAPS: Record<string, VertexModelCaps> = {
  "text-embedding-005": {
    nativeDim: 768,
    defaultDim: 768,
    maxBatchItems: 250,
    defaultConcurrency: 3,
  },
  "text-embedding-004": {
    nativeDim: 768,
    defaultDim: 768,
    maxBatchItems: 250,
    defaultConcurrency: 3,
  },
  "text-multilingual-embedding-002": {
    nativeDim: 768,
    defaultDim: 768,
    maxBatchItems: 250,
    defaultConcurrency: 3,
  },
  "gemini-embedding-001": {
    nativeDim: 3072,
    defaultDim: 256,
    maxBatchItems: 1,
    // One item per request → high call count. Default quota is typically
    // 100 RPM for this model; 5 concurrent requests at ~500ms latency yields
    // ~600 RPM peak, comfortably absorbed by retries on occasional 429s.
    defaultConcurrency: 5,
  },
};

// Vertex limits: 2,048 tokens per text, 20,000 tokens total per batch.
// We budget chars = tokens (1:1) — the worst case for dense code.
const MAX_PER_TEXT_CHARS = 2_000;
const MAX_BATCH_CHARS = 18_000;

export class VertexAIEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;

  private readonly project: string;
  private readonly location: string;
  private readonly authOptions: VertexAuthOptions;
  private readonly caps: VertexModelCaps;
  private readonly concurrency: number;
  /** Set when the effective dim is below the model's native dim — triggers outputDimensionality + L2 norm. */
  private readonly outputDimensionality: number | undefined;

  constructor(options: {
    model: string;
    project?: string;
    location?: string;
    keyFile?: string;
    dimensions?: number;
    /**
     * Number of concurrent :predict requests during indexing. Defaults are
     * picked per-model to fit published RPM quotas; raise this if your
     * project has higher quota, lower it if you see 429s.
     */
    concurrency?: number;
  }) {
    this.modelId = options.model;

    const project = options.project;
    if (!project) {
      throw new Error(
        "VertexAIEmbeddings: project is required. Set it in your lucerna.config.ts.",
      );
    }
    this.project = project;
    this.location = options.location ?? "us-central1";
    this.authOptions =
      options.keyFile !== undefined ? { keyFile: options.keyFile } : {};

    const caps = MODEL_CAPS[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `VertexAIEmbeddings: unknown model "${options.model}". Pass options.dimensions explicitly or use "vertex:${options.model}:<dims>" format.`,
      );
    }
    const dims = options.dimensions ?? 0;
    this.caps = caps ?? {
      nativeDim: dims,
      defaultDim: dims,
      maxBatchItems: 250,
      defaultConcurrency: 3,
    };
    this.dimensions = options.dimensions ?? this.caps.defaultDim;
    this.outputDimensionality =
      this.dimensions < this.caps.nativeDim ? this.dimensions : undefined;
    this.concurrency = Math.max(
      1,
      options.concurrency ?? this.caps.defaultConcurrency,
    );
  }

  async generate(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts, "RETRIEVAL_DOCUMENT");
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text], "CODE_RETRIEVAL_QUERY");
    return v ?? [];
  }

  private async embedBatch(
    texts: string[],
    taskType: "RETRIEVAL_DOCUMENT" | "CODE_RETRIEVAL_QUERY",
  ): Promise<number[][]> {
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.modelId}:predict`;
    const accessToken = await getVertexAccessToken(this.authOptions);

    const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
    const batches = Array.from(
      charBudgetBatches(pieces, MAX_BATCH_CHARS, this.caps.maxBatchItems),
    );

    // Dispatch batches concurrently — with maxBatchItems=1 models (e.g.
    // gemini-embedding-001) this is the only lever for throughput since the
    // server can't coalesce items.
    const batchVectors = await mapWithConcurrency(
      batches,
      this.concurrency,
      (batch) => this.sendBatch(url, accessToken, batch, taskType),
    );
    const pieceVectors = batchVectors.flat();

    // Google requires client-side L2 normalization when outputDimensionality
    // is below the model's native dim.
    const needsNormalize =
      this.outputDimensionality !== undefined &&
      this.outputDimensionality < this.caps.nativeDim;
    const normalized = needsNormalize
      ? pieceVectors.map(l2Normalize)
      : pieceVectors;

    return reassembleVectors(normalized, ranges);
  }

  private async sendBatch(
    url: string,
    accessToken: string,
    batch: string[],
    taskType: "RETRIEVAL_DOCUMENT" | "CODE_RETRIEVAL_QUERY",
  ): Promise<number[][]> {
    const body: Record<string, unknown> = {
      instances: batch.map((content) => ({ content, task_type: taskType })),
    };
    if (this.outputDimensionality !== undefined) {
      body.parameters = { outputDimensionality: this.outputDimensionality };
    }
    const payload = JSON.stringify(body);

    const res = await fetchWithRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      }),
    );
    if (!res.ok) {
      throw new Error(
        `VertexAIEmbeddings: API error ${res.status}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as {
      predictions: { embeddings: { values: number[] } }[];
    };
    return json.predictions.map((p) => p.embeddings.values);
  }
}
