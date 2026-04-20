import type { RerankingFunction } from "../types.js";
import { truncateWithEllipsis } from "./utils.js";

const API_ENDPOINT = "https://api.voyageai.com/v1/rerank";

// Voyage rerank-2.5 limits: 8,000 tokens per query, 32,000 total context tokens.
// Using ~3 chars/token (conservative for code).
const MAX_QUERY_CHARS = 24_000; // 8,000 tokens × 3 chars/token
const MAX_DOC_CHARS = 8_000; // ≈2,667 tokens/doc; leaves room for ~10 full-size docs in budget

/**
 * Reranking function using the Voyage AI rerank API.
 *
 * Supports up to 16K tokens per (query, document) pair — no truncation needed
 * for typical code chunks. Use `rerank-2.5` (default) for best quality or
 * `rerank-2` for the previous generation.
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

  constructor(options?: { model?: string; apiKey?: string }) {
    const apiKey = options?.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "VoyageReranker: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.model = options?.model ?? "rerank-2.5";
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
