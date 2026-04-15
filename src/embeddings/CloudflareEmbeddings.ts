import type { EmbeddingFunction } from "../types.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const MODEL = "@cf/baai/bge-m3";
const DIMENSIONS = 1024;
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
 * Embedding function using Cloudflare Workers AI with the `@cf/baai/bge-m3` model.
 *
 * Produces 1024-dimensional embeddings via plain fetch calls to the Cloudflare AI API.
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
 * });
 * ```
 */
export class CloudflareEmbeddings implements EmbeddingFunction {
  readonly dimensions = DIMENSIONS;
  readonly modelId = MODEL;
  private readonly apiToken: string;
  private readonly endpoint: string;

  constructor(
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "",
  ) {
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
    if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
    this.apiToken = apiToken;
    this.endpoint = `${API_BASE}/${accountId}/ai/run/${MODEL}`;
  }

  async generate(texts: string[]): Promise<number[][]> {
    // Split oversized texts into pieces so each piece fits in one request.
    // Track [start, end) ranges into the flattened pieces array.
    const pieces: string[] = [];
    const ranges: [number, number][] = [];

    for (const text of texts) {
      const start = pieces.length;
      if (text.length <= MAX_TEXT_CHARS) {
        pieces.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_TEXT_CHARS) {
          pieces.push(text.slice(i, i + MAX_TEXT_CHARS));
        }
      }
      ranges.push([start, pieces.length]);
    }

    // Embed all pieces using char-budget batches.
    const pieceVectors: number[][] = [];
    for (const batch of charBudgetBatches(pieces)) {
      const vectors = await this.fetchBatch(batch);
      pieceVectors.push(...vectors);
    }

    // Recombine: single-piece texts return as-is; multi-piece texts are averaged.
    return ranges.map(([start, end]) => {
      if (end - start === 1) return pieceVectors[start] ?? [];
      return averageVectors(pieceVectors.slice(start, end));
    });
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

/** Component-wise mean of a list of equal-length vectors. */
function averageVectors(vecs: number[][]): number[] {
  const dim = vecs[0]?.length ?? 0;
  const sum = new Array<number>(dim).fill(0);
  for (const vec of vecs) {
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (vec[i] ?? 0);
  }
  return sum.map((v) => v / vecs.length);
}

/**
 * Split texts into batches that stay under MAX_BATCH_CHARS and MAX_BATCH_ITEMS.
 * By the time this is called, all texts are already ≤ MAX_TEXT_CHARS chars.
 */
function* charBudgetBatches(texts: string[]): Generator<string[]> {
  let batch: string[] = [];
  let batchChars = 0;

  for (const text of texts) {
    const exceedsCharBudget =
      batch.length > 0 && batchChars + text.length > MAX_BATCH_CHARS;
    const exceedsItemLimit = batch.length >= MAX_BATCH_ITEMS;
    if (exceedsCharBudget || exceedsItemLimit) {
      yield batch;
      batch = [];
      batchChars = 0;
    }
    batch.push(text);
    batchChars += text.length;
  }

  if (batch.length > 0) yield batch;
}
