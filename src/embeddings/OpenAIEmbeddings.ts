import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.openai.com/v1/embeddings";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * Embedding function using the OpenAI Embeddings API.
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
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown OpenAI model "${options.model}" — pass dimensions explicitly via constructor option or "openai:${options.model}:<dims>" format`,
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
          ...(this.dimensions !== MODEL_DIMENSIONS[this.modelId]
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
