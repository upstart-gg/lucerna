import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

const MODEL_DIMENSIONS: Record<string, number> = {
  "voyage-code-3": 1024,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-3-large": 2048,
  "voyage-4": 1024,
  "voyage-4-lite": 512,
};

/**
 * Embedding function using the Voyage AI Embeddings API.
 *
 * `voyage-4` is the recommended model for code search.
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
 *   embeddingFunction: new VoyageEmbeddings({ model: 'voyage-4' }),
 * });
 * ```
 */
export class VoyageEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiKey: string;
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
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Voyage model "${options.model}" — pass dimensions explicitly via constructor option or "voyage:${options.model}:<dims>" format`,
        );
      })();
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
          input_type: "document",
        }),
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
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}
