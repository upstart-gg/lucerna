import type { EmbeddingFunction } from "../types.js";
import { l2Normalize } from "./utils.js";

const API_ENDPOINT = "https://api.jina.ai/v1/embeddings";

type JinaModelCaps = {
  /** Native output dimensionality of the model. */
  nativeDim: number;
  /** Default output dimensionality when `dimensions` is not passed. */
  defaultDim: number;
  /** Whether the model supports Matryoshka truncation via the `dimensions` request param. */
  matryoshka: boolean;
};

const MODEL_CAPS: Record<string, JinaModelCaps> = {
  "jina-embeddings-v3": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "jina-embeddings-v2-base-en": {
    nativeDim: 768,
    defaultDim: 768,
    matryoshka: false,
  },
  "jina-embeddings-v2-base-code": {
    nativeDim: 768,
    defaultDim: 768,
    matryoshka: false,
  },
  "jina-clip-v2": { nativeDim: 1024, defaultDim: 1024, matryoshka: false },
};

/**
 * Embedding function using the Jina AI Embeddings API.
 *
 * `jina-embeddings-v3` is Matryoshka-trained and supports truncation down to
 * 32 dimensions with minimal quality loss (~92% retention at 64). Lucerna
 * defaults to 512 for a ~50% smaller index at near-full quality — override
 * via the `dimensions` option if needed.
 *
 * Uses asymmetric retrieval: documents are embedded with
 * `task: "retrieval.passage"` and queries with `task: "retrieval.query"`.
 *
 * Requires a Jina AI API key via the `JINA_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * @example
 * ```ts
 * import { CodeIndexer, JinaEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new JinaEmbeddings({ model: 'jina-embeddings-v3' }),
 * });
 * ```
 */
export class JinaEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly caps: JinaModelCaps;
  /** Set when the effective dim is below the model's native dim — triggers dimensions + L2 norm. */
  private readonly outputDimensions: number | undefined;
  private readonly maxBatchSize = 2048;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "JinaEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;

    const caps = MODEL_CAPS[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `Unknown Jina model "${options.model}" — pass dimensions explicitly via constructor option or "jina:${options.model}:<dims>" format`,
      );
    }
    const dims = options.dimensions ?? 0;
    this.caps = caps ?? {
      nativeDim: dims,
      defaultDim: dims,
      matryoshka: false,
    };
    this.dimensions = options.dimensions ?? this.caps.defaultDim;
    this.outputDimensions =
      this.dimensions < this.caps.nativeDim ? this.dimensions : undefined;
  }

  async generate(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts, "retrieval.passage");
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text], "retrieval.query");
    return v ?? [];
  }

  private async embedBatch(
    texts: string[],
    task: "retrieval.passage" | "retrieval.query",
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const body: Record<string, unknown> = {
        model: this.modelId,
        input: batch,
        task,
      };
      if (this.outputDimensions !== undefined) {
        body.dimensions = this.outputDimensions;
      }
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(
          `Jina Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      const vectors = sorted.map((d) => d.embedding);
      // Re-normalize when truncating so the index is guaranteed unit-norm.
      const normalized =
        this.outputDimensions !== undefined
          ? vectors.map(l2Normalize)
          : vectors;
      results.push(...normalized);
    }
    return results;
  }
}
