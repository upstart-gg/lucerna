import type { EmbeddingFunction } from "../types.js";
import { charBudgetBatches, prepareTexts, reassembleVectors } from "./utils.js";

const API_ENDPOINT = "https://api.mistral.ai/v1/embeddings";

const MODEL_DIMENSIONS: Record<string, number> = {
  "codestral-embed": 1024,
  "mistral-embed": 1024,
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
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Mistral model "${options.model}" — pass dimensions explicitly via constructor option or "mistral:${options.model}:<dims>" format`,
        );
      })();
  }

  async generate(texts: string[]): Promise<number[][]> {
    const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
    const pieceVectors: number[][] = [];

    for (const batch of charBudgetBatches(
      pieces,
      MAX_BATCH_CHARS,
      MAX_BATCH_ITEMS,
    )) {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.modelId, input: batch }),
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
      pieceVectors.push(...sorted.map((d) => d.embedding));
    }

    return reassembleVectors(pieceVectors, ranges);
  }
}
