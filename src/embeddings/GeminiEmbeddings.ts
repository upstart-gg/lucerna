import type { EmbeddingFunction } from "../types.js";
import { charBudgetBatches, prepareTexts, reassembleVectors } from "./utils.js";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
};

// Gemini limits: 2,048 tokens per text, 20,000 tokens total per batch, 250 texts max.
// Using ~2 chars/token (conservative for code); 10% safety margin on batch total.
const MAX_PER_TEXT_CHARS = 4_000; // 2,048 tokens × 2 chars/token
const MAX_BATCH_CHARS = 36_000; // 18,000 tokens × 2 chars/token
const MAX_BATCH_ITEMS = 250;

/**
 * Embedding function using the Google Gemini Embeddings API.
 *
 * Requires a Google API key via the `GOOGLE_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * `text-embedding-004` (768-dim) is recommended for code search. Use
 * `gemini-embedding-001` for higher quality at the cost of larger vectors.
 *
 * @example
 * ```ts
 * import { CodeIndexer, GeminiEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new GeminiEmbeddings({ model: 'text-embedding-004' }),
 * });
 * ```
 */
export class GeminiEmbeddings implements EmbeddingFunction {
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
        "GeminiEmbeddings: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.modelId = options.model;
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Gemini model "${options.model}" — pass dimensions explicitly via constructor option or "gemini:${options.model}:<dims>" format`,
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
      pieceVectors.push(...(await this.batchEmbed(batch)));
    }

    return reassembleVectors(pieceVectors, ranges);
  }

  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:batchEmbedContents?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.modelId}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
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
    return json.embeddings.map((e) => e.values);
  }
}
