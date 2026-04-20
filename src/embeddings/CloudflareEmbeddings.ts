import type { EmbeddingFunction } from "../types.js";
import { charBudgetBatches, prepareTexts, reassembleVectors } from "./utils.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_MODEL = "@cf/baai/bge-m3";
const DEFAULT_DIMENSIONS = 1024;
// bge-m3 hard limit: 60,000 tokens per request (all texts combined).
// Token density varies by content:
//   • prose / imports : ~2  tokens/char
//   • typical code    : ~5  tokens/char
//   • dense code      : ~10 tokens/char (numeric literals, ANSI escapes, etc.)
//
// Safe combined-char budget = 60,000 / 10 = 6,000 chars. We use 4,500 for margin.
// Texts larger than MAX_TEXT_CHARS are split into pieces and their vectors averaged —
// this keeps ALL content indexed without any truncation or data loss.
const MAX_TEXT_CHARS = 4_500;
const MAX_BATCH_CHARS = 4_500; // matches MAX_TEXT_CHARS so one large piece = one batch
const MAX_BATCH_ITEMS = 10;
const MAX_RETRIES = 3;

/**
 * Embedding function using Cloudflare Workers AI.
 *
 * Defaults to the `@cf/baai/bge-m3` model (1024 dimensions). Pass `model` and
 * `dimensions` to use a different Cloudflare AI embedding model.
 *
 * Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables,
 * or explicit constructor arguments.
 *
 * Texts longer than MAX_TEXT_CHARS are automatically split into pieces and their
 * embeddings averaged, ensuring all content is indexed without truncation.
 *
 * @example
 * ```ts
 * import { CodeIndexer, CloudflareEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new CloudflareEmbeddings(),
 *   // or: new CloudflareEmbeddings({ model: '@cf/baai/bge-large-en-v1.5', dimensions: 1024 })
 * });
 * ```
 */
export class CloudflareEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly apiToken: string;
  private readonly endpoint: string;

  constructor(options?: {
    model?: string;
    dimensions?: number;
    accountId?: string;
    apiToken?: string;
  }) {
    const accountId = options?.accountId ?? "";
    const apiToken = options?.apiToken ?? "";
    if (!accountId)
      throw new Error(
        "CloudflareEmbeddings: accountId is required. Set it in your lucerna.config.ts.",
      );
    if (!apiToken)
      throw new Error(
        "CloudflareEmbeddings: apiToken is required. Set it in your lucerna.config.ts.",
      );
    this.apiToken = apiToken;
    this.modelId = options?.model ?? DEFAULT_MODEL;
    this.dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;
    this.endpoint = `${API_BASE}/${accountId}/ai/run/${this.modelId}`;
  }

  async generate(texts: string[]): Promise<number[][]> {
    const { pieces, ranges } = prepareTexts(texts, MAX_TEXT_CHARS);

    const pieceVectors: number[][] = [];
    for (const batch of charBudgetBatches(
      pieces,
      MAX_BATCH_CHARS,
      MAX_BATCH_ITEMS,
    )) {
      const vectors = await this.fetchBatch(batch);
      pieceVectors.push(...vectors);
    }

    return reassembleVectors(pieceVectors, ranges);
  }

  private async fetchBatch(texts: string[]): Promise<number[][]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(200 * 2 ** (attempt - 1));
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        lastError = new Error(
          `Cloudflare AI request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
        // Retry on server errors (5xx); give up immediately on client errors (4xx)
        if (response.status < 500) throw lastError;
        continue;
      }

      const json = (await response.json()) as {
        success: boolean;
        result: { data: number[][] };
        errors?: { message: string }[];
      };

      if (!json.success) {
        const msg =
          json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
        throw new Error(`Cloudflare AI error: ${msg}`);
      }

      return json.result.data;
    }
    throw lastError ?? new Error("Cloudflare AI request failed after retries");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
