import type { EmbeddingFunction } from "../types.js";

const MODEL_DIMENSIONS: Record<string, number> = {
  "nomic-embed-text": 768,
  "nomic-embed-text-v2-moe": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
  "bge-large": 1024,
  "bge-m3": 1024,
};

/**
 * Embedding function using a locally-running Ollama instance.
 *
 * No API key required — Ollama runs locally, making it free and private.
 * Requires a GPU for acceptable performance with larger models.
 *
 * Set `OLLAMA_HOST` to override the default `http://localhost:11434`.
 *
 * Recommended models:
 * - `nomic-embed-text` — 768-dim, fast, well-tested
 * - `mxbai-embed-large` — 1024-dim, higher quality (requires GPU)
 *
 * @example
 * ```ts
 * import { CodeIndexer, OllamaEmbeddings } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new OllamaEmbeddings({ model: 'nomic-embed-text' }),
 * });
 * ```
 */
export class OllamaEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly host: string;
  private readonly maxBatchSize = 32;

  constructor(options: { model: string; host?: string; dimensions?: number }) {
    this.host =
      options.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.modelId = options.model;
    this.dimensions =
      options.dimensions ??
      MODEL_DIMENSIONS[options.model] ??
      (() => {
        throw new Error(
          `Unknown Ollama model "${options.model}" — pass dimensions explicitly via constructor option or "ollama:${options.model}:<dims>" format`,
        );
      })();
  }

  async generate(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      let response: Response;
      try {
        response = await fetch(`${this.host}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelId, input: batch }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw new Error(
          `Ollama request failed — is Ollama running at ${this.host}?\n` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `Ollama Embeddings request failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as { embeddings: number[][] };
      results.push(...json.embeddings);
    }
    return results;
  }
}
