import type { EmbeddingFunction } from "../types.js";

const API_ENDPOINT = "https://api.mistral.ai/v1/embeddings";

const MODEL_DIMENSIONS: Record<string, number> = {
  "codestral-embed": 1024,
  "mistral-embed": 1024,
};

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
  private readonly maxBatchSize = 512;

  constructor(options: {
    model: string;
    apiKey?: string;
    dimensions?: number;
  }) {
    const apiKey = options.apiKey ?? process.env.MISTRAL_API_KEY ?? "";
    if (!apiKey) throw new Error("MISTRAL_API_KEY is required");
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
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
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
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}
