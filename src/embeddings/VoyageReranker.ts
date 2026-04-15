import type { RerankingFunction } from "../types.js";

const API_ENDPOINT = "https://api.voyageai.com/v1/rerank";

/**
 * Reranking function using the Voyage AI rerank API.
 *
 * Supports up to 16K tokens per (query, document) pair — no truncation needed
 * for typical code chunks. Use `rerank-2` (default) for best quality or
 * `rerank-lite-1` for lower latency.
 *
 * Requires a Voyage AI API key via the `VOYAGE_API_KEY` environment variable
 * or explicit constructor argument.
 *
 * @example
 * ```ts
 * import { CodeIndexer, VoyageReranker } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   rerankingFunction: new VoyageReranker(),
 * });
 * ```
 */
export class VoyageReranker implements RerankingFunction {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey = process.env.VOYAGE_API_KEY ?? "", model = "rerank-2") {
    if (!apiKey) throw new Error("VOYAGE_API_KEY is required");
    this.apiKey = apiKey;
    this.model = model;
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];

    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: texts,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `Voyage Reranker request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data: { index: number; relevance_score: number }[];
    };

    // Re-map results by index to preserve original input order
    const scores = new Array<number>(texts.length).fill(0);
    for (const item of json.data) {
      scores[item.index] = item.relevance_score;
    }
    return scores;
  }
}
