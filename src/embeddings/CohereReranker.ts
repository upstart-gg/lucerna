import type { RerankingFunction } from "../types.js";
import { truncateWithEllipsis } from "./utils.js";

const API_ENDPOINT = "https://api.cohere.com/v2/rerank";

// Cohere rerank v3: 4,096 tokens per (query + document) combined.
// Split budget evenly; using 2 chars/token for code.
const MAX_DOC_CHARS = 4_000; // ~2,000 tokens
const MAX_QUERY_CHARS = 4_000; // ~2,000 tokens

/**
 * Reranking function using the Cohere Rerank API.
 *
 * Requires a Cohere API key via the `COHERE_API_KEY` environment variable
 * or explicit `apiKey` option.
 *
 * Recommended models:
 * - `rerank-english-v3.0` — best for English-only codebases
 * - `rerank-multilingual-v3.0` — for multilingual projects
 *
 * @example
 * ```ts
 * import { CodeIndexer, CohereReranker } from '@upstart.gg/lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   rerankingFunction: new CohereReranker({ model: 'rerank-english-v3.0' }),
 * });
 * ```
 */
export class CohereReranker implements RerankingFunction {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options?: { model?: string; apiKey?: string }) {
    const apiKey = options?.apiKey ?? "";
    if (!apiKey)
      throw new Error(
        "CohereReranker: apiKey is required. Set it in your lucerna.config.ts.",
      );
    this.apiKey = apiKey;
    this.model = options?.model ?? "rerank-english-v3.0";
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
        `Cohere Reranker request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      results: { index: number; relevance_score: number }[];
    };

    const scores = new Array<number>(texts.length).fill(0);
    for (const item of json.results) {
      scores[item.index] = item.relevance_score;
    }
    return scores;
  }
}
