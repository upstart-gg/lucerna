import type { EmbeddingFunction } from "../types.js";

const MODEL_DIMENSIONS: Record<string, number> = {
  "nomic-embed-text": 768,
  "text-embedding-nomic-embed-text-v1.5": 768,
  "mxbai-embed-large": 1024,
  "bge-small-en-v1.5": 384,
  "bge-large-en-v1.5": 1024,
  "bge-m3": 1024,
  "all-minilm-l6-v2": 384,
};

/**
 * Embedding function using a locally-running LM Studio instance.
 *
 * No API key required — LM Studio runs locally, making it free and private.
 * Uses the OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Enable the local server in LM Studio: Settings → Local Server → Start Server.
 * Set `LMSTUDIO_BASE_URL` to override the default `http://localhost:1234`.
 *
 * Recommended models:
 * - `nomic-embed-text` — 768-dim, fast, well-tested
 * - `mxbai-embed-large` — 1024-dim, higher quality (requires GPU)
 *
 * @example
 * ```ts
 * import { CodeIndexer, LMStudioEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new LMStudioEmbeddings({ model: 'nomic-embed-text' }),
 * });
 * ```
 */
export class LMStudioEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly maxBatchSize = 32;

  constructor(options: {
    model: string;
    baseUrl?: string;
    dimensions?: number;
  }) {
    this.baseUrl = options.baseUrl ?? "http://localhost:1234";
    this.modelId = options.model;
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown LM Studio model "${options.model}" — pass dimensions explicitly via constructor option or "lmstudio:${options.model}:<dims>" format`,
        );
      })();
  }

  async generate(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelId, input: batch }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw new Error(
          `LM Studio request failed — is LM Studio running at ${this.baseUrl}?\n` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `LM Studio Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as {
        data: { embedding: number[] }[];
      };
      results.push(...json.data.map((d) => d.embedding));
    }
    return results;
  }
}
