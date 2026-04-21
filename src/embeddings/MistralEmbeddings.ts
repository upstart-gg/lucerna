import type { EmbeddingFunction } from "../types.js";
import {
  charBudgetBatches,
  l2Normalize,
  prepareTexts,
  reassembleVectors,
} from "./utils.js";

const API_ENDPOINT = "https://api.mistral.ai/v1/embeddings";

type MistralModelCaps = {
  /** Native output dimensionality of the model. */
  nativeDim: number;
  /** Default output dimensionality when `dimensions` is not passed. */
  defaultDim: number;
  /** Whether the model supports Matryoshka truncation via `output_dimension`. */
  matryoshka: boolean;
};

const MODEL_CAPS: Record<string, MistralModelCaps> = {
  "codestral-embed": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
  "mistral-embed": { nativeDim: 1024, defaultDim: 512, matryoshka: true },
};

// Mistral limits: 8,190 tokens per text, 128 texts max per batch, 16,384 tokens total per batch.
// Using ~3 chars/token (conservative for code); targeting ~15,000 tokens for safety margin.
const MAX_PER_TEXT_CHARS = 24_000; // 8,000 tokens × 3 chars/token
const MAX_BATCH_CHARS = 45_000; // 15,000 tokens × 3 chars/token
const MAX_BATCH_ITEMS = 128; // API hard limit (previously incorrectly set to 512)

/**
 * Embedding function using the Mistral AI Embeddings API.
 *
 * `codestral-embed` is the recommended model for code search.
 * `mistral-embed` is a good alternative for mixed text and code.
 *
 * Both models are Matryoshka-trained. Lucerna defaults to 512 dimensions for
 * a ~50% smaller index with negligible quality loss — override via the
 * `dimensions` option to use the native 1024 or any lower Matryoshka-aligned
 * value.
 *
 * Requires a Mistral AI API key via the `MISTRAL_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * @example
 * ```ts
 * import { CodeIndexer, MistralEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new MistralEmbeddings({ model: 'codestral-embed' }),
 * });
 * ```
 */
export class MistralEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly caps: MistralModelCaps;
  /** Set when the effective dim is below the model's native dim — triggers output_dimension + L2 norm. */
  private readonly outputDimension: number | undefined;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "MistralEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;

    const caps = MODEL_CAPS[options.model];
    if (!caps && options.dimensions === undefined) {
      throw new Error(
        `Unknown Mistral model "${options.model}" — pass dimensions explicitly via constructor option or "mistral:${options.model}:<dims>" format`,
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
    const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
    const pieceVectors: number[][] = [];

    for (const batch of charBudgetBatches(
      pieces,
      MAX_BATCH_CHARS,
      MAX_BATCH_ITEMS,
    )) {
      const body: Record<string, unknown> = {
        model: this.modelId,
        input: batch,
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
          `Mistral Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      const vectors = sorted.map((d) => d.embedding);
      // Re-normalize when truncating so the index is guaranteed unit-norm.
      const normalized =
        this.outputDimension !== undefined ? vectors.map(l2Normalize) : vectors;
      pieceVectors.push(...normalized);
    }

    return reassembleVectors(pieceVectors, ranges);
  }
}
