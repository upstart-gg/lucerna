import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.openai.com/v1/embeddings";

type OpenAIModelCaps = {
  /** Native output dimensionality of the model. */
  nativeDim: number;
  /** Default output dimensionality when `dimensions` is not passed. */
  defaultDim: number;
  /** Whether the model supports Matryoshka truncation via the `dimensions` request param. */
  matryoshka: boolean;
};

const MODEL_CAPS: Record<string, OpenAIModelCaps> = {
  "text-embedding-3-small": {
    nativeDim: 1536,
    defaultDim: 512,
    matryoshka: true,
  },
  "text-embedding-3-large": {
    nativeDim: 3072,
    defaultDim: 768,
    matryoshka: true,
  },
  "text-embedding-ada-002": {
    nativeDim: 1536,
    defaultDim: 1536,
    matryoshka: false,
  },
};

/**
 * Embedding function using the OpenAI Embeddings API.
 *
 * The `text-embedding-3-*` models are Matryoshka-trained and support
 * truncation via the `dimensions` API parameter. Lucerna defaults to 512
 * (small) or 768 (large) — at these sizes the MTEB numbers still beat
 * `text-embedding-ada-002` at its full 1536, per OpenAI's own benchmarks.
 * Override via the `dimensions` option if you need more.
 *
 * Requires an OpenAI API key via the `OPENAI_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * @example
 * ```ts
 * import { CodeIndexer, OpenAIEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new OpenAIEmbeddings({ model: 'text-embedding-3-small' }),
 * });
 * ```
 */
export class OpenAIEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly caps: OpenAIModelCaps;
  private readonly maxBatchSize = 2048;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "OpenAIEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;

    const caps = MODEL_CAPS[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `Unknown OpenAI model "${options.model}" — pass dimensions explicitly via constructor option or "openai:${options.model}:<dims>" format`,
      );
    }
    const dims = options.dimensions ?? 0;
    this.caps = caps ?? {
      nativeDim: dims,
      defaultDim: dims,
      matryoshka: false,
    };
    this.dimensions = options.dimensions ?? this.caps.defaultDim;
  }

  async generate(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          input: batch,
          // OpenAI normalizes server-side when `dimensions` < native — no
          // client-side L2 norm needed.
          ...(this.dimensions !== this.caps.nativeDim
            ? { dimensions: this.dimensions }
            : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(
          `OpenAI Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      // Sort by index to preserve input order
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}
