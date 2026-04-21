import type { EmbeddingFunction } from "../types.js";
import {
  charBudgetBatches,
  l2Normalize,
  prepareTexts,
  reassembleVectors,
} from "./utils.js";

type ModelCapabilities = {
  /** Native output dimensionality of the model. */
  nativeDim: number;
  /** Default output dimensionality when the user does not pass `dimensions` explicitly. */
  defaultDim: number;
  /** Whether the model accepts `taskType` in the request body. */
  supportsTaskType: boolean;
  /** Max input chars per text (1 char = 1 token worst case). */
  maxPerTextChars: number;
};

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "text-embedding-004": {
    nativeDim: 768,
    defaultDim: 768,
    supportsTaskType: true,
    maxPerTextChars: 2_000,
  },
  "gemini-embedding-001": {
    nativeDim: 3072,
    defaultDim: 256,
    supportsTaskType: true,
    maxPerTextChars: 2_000,
  },
  "gemini-embedding-2-preview": {
    nativeDim: 3072,
    defaultDim: 256,
    supportsTaskType: false,
    maxPerTextChars: 8_000,
  },
};

// Gemini batch limits: 20,000 tokens total per batch, 250 texts max.
// We budget chars = tokens (1:1) — the worst case for dense code.
const MAX_BATCH_CHARS = 18_000; // ≤ 18,000 tokens at worst case (10% under 20k limit)
const MAX_BATCH_ITEMS = 250;

const CODE_QUERY_PREFIX = "task: code retrieval | query: ";

/**
 * Embedding function using the Google Gemini Embeddings API.
 *
 * Requires a Google API key via the `GOOGLE_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * Supports asymmetric code retrieval: `generate()` embeds documents with
 * `RETRIEVAL_DOCUMENT`, and `embedQuery()` embeds natural-language queries
 * with `CODE_RETRIEVAL_QUERY` (or the prompt-prefix equivalent for
 * `gemini-embedding-2-preview`, which does not accept `taskType`).
 *
 * @example
 * ```ts
 * import { CodeIndexer, GeminiEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new GeminiEmbeddings({
 *     model: 'gemini-embedding-2-preview',
 *     dimensions: 256,
 *   }),
 * });
 * ```
 */
export class GeminiEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly caps: ModelCapabilities;
  /** Set when the effective dim is below the model's native dim — triggers outputDimensionality + L2 norm. */
  private readonly outputDimensionality: number | undefined;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "GeminiEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;

    const caps = MODEL_CAPABILITIES[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `Unknown Gemini model "${options.model}" — pass dimensions explicitly via constructor option or "gemini:${options.model}:<dims>" format`,
      );
    }
    const dims = options.dimensions ?? 0;
    this.caps = caps ?? {
      nativeDim: dims,
      defaultDim: dims,
      supportsTaskType: false,
      maxPerTextChars: 2_000,
    };
    this.dimensions = options.dimensions ?? this.caps.defaultDim;
    this.outputDimensionality =
      this.dimensions < this.caps.nativeDim ? this.dimensions : undefined;
  }

  async generate(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts, "document");
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text], "query");
    return v ?? [];
  }

  private async embedBatch(
    texts: string[],
    task: "document" | "query",
  ): Promise<number[][]> {
    const formatted =
      task === "query" && !this.caps.supportsTaskType
        ? texts.map((t) => CODE_QUERY_PREFIX + t)
        : texts;
    const { pieces, ranges } = prepareTexts(
      formatted,
      this.caps.maxPerTextChars,
    );
    const pieceVectors: number[][] = [];

    for (const batch of charBudgetBatches(
      pieces,
      MAX_BATCH_CHARS,
      MAX_BATCH_ITEMS,
    )) {
      pieceVectors.push(...(await this.sendBatch(batch, task)));
    }

    return reassembleVectors(pieceVectors, ranges);
  }

  private async sendBatch(
    texts: string[],
    task: "document" | "query",
  ): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:batchEmbedContents?key=${this.apiKey}`;
    const taskType =
      task === "query" ? "CODE_RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.modelId}`,
          content: { parts: [{ text }] },
          ...(this.caps.supportsTaskType ? { taskType } : {}),
          ...(this.outputDimensionality !== undefined
            ? { outputDimensionality: this.outputDimensionality }
            : {}),
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(
        `Gemini Embeddings request failed: ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as {
      embeddings: { values: number[] }[];
    };
    const vectors = json.embeddings.map((e) => e.values);
    // Google requires client-side L2 normalization when output_dimensionality
    // is below the model's native dim — the API only normalizes at native dim.
    const needsNormalize =
      this.outputDimensionality !== undefined &&
      this.outputDimensionality < this.caps.nativeDim;
    return needsNormalize ? vectors.map(l2Normalize) : vectors;
  }
}
