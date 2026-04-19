import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.cohere.com/v2/embed";

const MODEL_DIMENSIONS: Record<string, number> = {
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "embed-english-light-v3.0": 384,
  "embed-multilingual-light-v3.0": 384,
};

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
  private readonly maxBatchSize = 96;

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
      results.push(...json.embeddings.float);
    }
    return results;
  }
}
