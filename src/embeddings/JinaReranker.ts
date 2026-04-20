import type { RerankingFunction } from "../types.js";
import { truncateWithEllipsis } from "./utils.js";

const API_ENDPOINT = "https://api.jina.ai/v1/rerank";

// jina-reranker-v3: 131,072 combined tokens. Truncation is a cost/perf guardrail.
const MAX_DOC_CHARS = 16_000; // ~8,000 tokens
const MAX_QUERY_CHARS = 4_000;

/**
 * Reranking function using the Jina AI reranker API.
 *
 * Supports up to 8K tokens per (query, document) pair — no truncation needed
 * for typical code chunks. Uses `jina-reranker-v3` (default) which has
 * strong performance on code retrieval tasks.
 *
 * Requires a Jina AI API key via the `JINA_API_KEY` environment variable
 * or explicit constructor argument.
 *
 * @example
 * ```ts
 * import { CodeIndexer, JinaReranker } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   rerankingFunction: new JinaReranker(),
 * });
 * ```
 */
export class JinaReranker implements RerankingFunction {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options?: { model?: string; apiKey?: string }) {
    const apiKey = options?.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "JinaReranker: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.model = options?.model ?? "jina-reranker-v3";
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];

    const safeQuery = truncateWithEllipsis(query, MAX_QUERY_CHARS);
    const safeDocuments = texts.map((t) =>
      truncateWithEllipsis(t, MAX_DOC_CHARS),
    );

    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query: safeQuery,
        documents: safeDocuments,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `Jina Reranker request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      results: { index: number; relevance_score: number }[];
    };

    // Re-map results by index to preserve original input order
    const scores = new Array<number>(texts.length).fill(0);
    for (const item of json.results) {
      scores[item.index] = item.relevance_score;
    }
    return scores;
  }
}
