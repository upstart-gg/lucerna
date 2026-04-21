import type { EmbeddingFunction } from "../types.js";
import { l2Normalize } from "./utils.js";

const API_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

type VoyageModelCaps = {
  /** Native output dimensionality of the model. */
  nativeDim: number;
  /** Default output dimensionality when `dimensions` is not passed. */
  defaultDim: number;
  /** Whether the model supports Matryoshka truncation via `output_dimension`. */
  matryoshka: boolean;
};

const MODEL_CAPS: Record<string, VoyageModelCaps> = {
  "voyage-code-3": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "voyage-3": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "voyage-3.5": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "voyage-3.5-lite": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "voyage-3-lite": { nativeDim: 512, defaultDim: 512, matryoshka: true },
  "voyage-3-large": { nativeDim: 2048, defaultDim: 1024, matryoshka: true },
  "voyage-4": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "voyage-4-lite": { nativeDim: 512, defaultDim: 512, matryoshka: true },
};

/**
 * Embedding function using the Voyage AI Embeddings API.
 *
 * `voyage-code-3` is the recommended model for code search. All Voyage models
 * support Matryoshka truncation — Lucerna defaults to a reduced dimensionality
 * (512 for 1024-native models, 1024 for `voyage-3-large`) to keep the index
 * small with negligible quality loss. Override with `dimensions` to get the
 * native size or any Matryoshka-aligned value (256 / 512 / 1024 / 2048).
 *
 * Uses asymmetric retrieval: documents are embedded with `input_type: "document"`
 * and queries with `input_type: "query"`.
 *
 * Requires a Voyage AI API key via the `VOYAGE_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * @example
 * ```ts
 * import { CodeIndexer, VoyageEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new VoyageEmbeddings({ model: 'voyage-code-3' }),
 * });
 * ```
 */
export class VoyageEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly caps: VoyageModelCaps;
  /** Set when the effective dim is below the model's native dim — triggers output_dimension + L2 norm. */
  private readonly outputDimension: number | undefined;
  private readonly maxBatchSize = 128;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "VoyageEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;

    const caps = MODEL_CAPS[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `Unknown Voyage model "${options.model}" — pass dimensions explicitly via constructor option or "voyage:${options.model}:<dims>" format`,
      );
    }
    const dims = options.dimensions ?? 0;
    this.caps = caps ?? {
      nativeDim: dims,
      defaultDim: dims,
      matryoshka: false,
    };
    this.dimensions = options.dimensions ?? this.caps.defaultDim;
    this.outputDimension =
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
    inputType: "document" | "query",
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const body: Record<string, unknown> = {
        model: this.modelId,
        input: batch,
        input_type: inputType,
      };
      if (this.outputDimension !== undefined) {
        body.output_dimension = this.outputDimension;
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
          `Voyage Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      const vectors = sorted.map((d) => d.embedding);
      // Voyage returns already-normalized vectors, but re-normalize defensively
      // whenever we asked for a truncated dim so the index is guaranteed unit-norm.
      const normalized =
        this.outputDimension !== undefined ? vectors.map(l2Normalize) : vectors;
      results.push(...normalized);
    }
    return results;
  }
}
