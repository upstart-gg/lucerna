import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.jina.ai/v1/embeddings";

const MODEL_DIMENSIONS: Record<string, number> = {
  "jina-embeddings-v3": 1024,
  "jina-embeddings-v2-base-en": 768,
  "jina-embeddings-v2-base-code": 768,
  "jina-clip-v2": 1024,
};

/**
 * Embedding function using the Jina AI Embeddings API.
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
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Jina model "${options.model}" — pass dimensions explicitly via constructor option or "jina:${options.model}:<dims>" format`,
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
          task: "retrieval.passage",
        }),
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
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}
