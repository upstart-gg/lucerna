import type { EmbeddingFunction } from "../types.js";
import { charBudgetBatches, prepareTexts, reassembleVectors } from "./utils.js";

const API_ENDPOINT = "https://api.cohere.com/v2/embed";

const MODEL_DIMENSIONS: Record<string, number> = {
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "embed-english-light-v3.0": 384,
  "embed-multilingual-light-v3.0": 384,
};

// Cohere limits: 512 tokens per text (hard limit), 96 texts per batch.
// Using ~3 chars/token (conservative for code).
// Texts exceeding MAX_PER_TEXT_CHARS are split into chunks and their vectors averaged.
const MAX_PER_TEXT_CHARS = 1_500; // 512 tokens × 3 chars/token
const MAX_BATCH_ITEMS = 96;

/**
 * Embedding function using the Cohere Embed API.
 *
 * Requires a Cohere API key via the `COHERE_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * @example
 * ```ts
 * import { CodeIndexer, CohereEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new CohereEmbeddings({ model: 'embed-english-v3.0' }),
 * });
 * ```
 */
export class CohereEmbeddings implements EmbeddingFunction {
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
        "CohereEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Cohere model "${options.model}" — pass dimensions explicitly via constructor option or "cohere:${options.model}:<dims>" format`,
        );
      })();
  }

  async generate(texts: string[]): Promise<number[][]> {
    const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
    const pieceVectors: number[][] = [];

    // Cohere has a 96-item batch limit but no explicit total-token batch limit;
    // use item-only batching (pass a very large char budget so only items limit applies).
    for (const batch of charBudgetBatches(
      pieces,
      Number.MAX_SAFE_INTEGER,
      MAX_BATCH_ITEMS,
    )) {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          texts: batch,
          input_type: "search_document",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(
          `Cohere Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        embeddings: { float: number[][] };
      };
      pieceVectors.push(...json.embeddings.float);
    }

    return reassembleVectors(pieceVectors, ranges);
  }
}
