import type { RerankingFunction } from "../types.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_MODEL = "@cf/baai/bge-reranker-base";

// bge-reranker-base has a 512-token context limit. Code averages ~4 chars/token,
// so ~2048 chars ≈ 512 tokens. We preserve head + tail rather than blindly
// slicing the front: the head carries the function signature/docstring while
// the tail carries return/throw logic — both are high-signal for reranking.
const MAX_RERANKER_CHARS = 2048;
const HEAD_CHARS = 1024;
const TAIL_CHARS = 900; // head + marker (~10 chars) + tail ≤ ~1934, safely under 2048

function truncateForReranker(text: string): string {
  if (text.length <= MAX_RERANKER_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n/* … */\n${text.slice(-TAIL_CHARS)}`;
}

/**
 * Reranking function using Cloudflare Workers AI.
 *
 * Defaults to the `@cf/baai/bge-reranker-base` model. Pass `model` to use a
 * different Cloudflare AI reranker model.
 *
 * Takes a query and candidate texts, returns a relevance score per text in (0,1)
 * via sigmoid-normalised cross-encoder logits. Use as a second stage after RRF fusion
 * to improve final result precision in RAG / code-search pipelines.
 *
 * **Truncation:** `bge-reranker-base` has a 512-token context limit (~2048 chars for
 * code). Texts exceeding this are truncated using a head+tail strategy: the first
 * ~1024 chars (function signature/docstring) and last ~900 chars (return/throw logic)
 * are preserved, with the middle replaced by `\/\* … *\/`. This retains the most
 * diagnostic signal for code reranking.
 *
 * Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables,
 * or explicit constructor arguments.
 *
 * @example
 * ```ts
 * import { CodeIndexer, CloudflareReranker } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   rerankingFunction: new CloudflareReranker(),
 *   // or: new CloudflareReranker({ model: '@cf/baai/bge-reranker-large' })
 * });
 * ```
 */
export class CloudflareReranker implements RerankingFunction {
  private readonly apiToken: string;
  private readonly endpoint: string;

  constructor(options?: {
    model?: string;
    accountId?: string;
    apiToken?: string;
  }) {
    const accountId = options?.accountId ?? "";
    const apiToken = options?.apiToken ?? "";
    if (!accountId)
      throw new Error(
        "CloudflareReranker: accountId is required. Set it in your lucerna.config.ts.",
      );
    if (!apiToken)
      throw new Error(
        "CloudflareReranker: apiToken is required. Set it in your lucerna.config.ts.",
      );
    this.apiToken = apiToken;
    const model = options?.model ?? DEFAULT_MODEL;
    this.endpoint = `${API_BASE}/${accountId}/ai/run/${model}`;
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];

    const truncated = texts.map(truncateForReranker);

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        contexts: truncated.map((text) => ({ text })),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `Cloudflare Reranker request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      success: boolean;
      result: { response: { id: number; score: number }[] };
      errors?: { message: string }[];
    };

    if (!json.success) {
      const msg =
        json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
      throw new Error(`Cloudflare Reranker error: ${msg}`);
    }

    // The API returns results sorted by score descending with an `id` field
    // pointing back to the original input index — re-map to preserve input order.
    const scores = new Array<number>(texts.length).fill(0);
    for (const item of json.result.response) {
      scores[item.id] = item.score;
    }
    return scores;
  }
}
