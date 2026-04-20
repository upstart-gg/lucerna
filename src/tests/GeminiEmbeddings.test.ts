import { afterEach, describe, expect, mock, test } from "bun:test";
import { GeminiEmbeddings } from "../embeddings/GeminiEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

const VALID_OPTS = { model: "text-embedding-004", apiKey: "my-key" };

function makeEmbeddingResponse(batchSize: number) {
  return new Response(
    JSON.stringify({
      embeddings: Array.from({ length: batchSize }, (_, i) => ({
        values: [i + 1, 0],
      })),
    }),
    { status: 200 },
  );
}

describe("GeminiEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () => new GeminiEmbeddings({ model: "text-embedding-004", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new GeminiEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown Gemini model");
  });

  test("dimensions defaults to 768 for text-embedding-004", () => {
    const emb = new GeminiEmbeddings(VALID_OPTS);
    expect(emb.dimensions).toBe(768);
  });

  test("dimensions is 3072 for gemini-embedding-001", () => {
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(3072);
  });

  test("returns vectors for a small batch", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: unknown[] };
        return makeEmbeddingResponse(body.requests.length);
      },
    );
    const emb = new GeminiEmbeddings(VALID_OPTS);
    const result = await emb.generate(["foo", "bar"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1, 0]);
    expect(result[1]).toEqual([2, 0]);
  });

  test("sends correct URL with API key", async () => {
    let capturedUrl: string | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        const body = JSON.parse(init.body as string) as { requests: unknown[] };
        return makeEmbeddingResponse(body.requests.length);
      },
    );
    const emb = new GeminiEmbeddings(VALID_OPTS);
    await emb.generate(["test"]);
    expect(capturedUrl).toContain("text-embedding-004");
    expect(capturedUrl).toContain("my-key");
  });

  test("splits oversized text and returns one averaged vector", async () => {
    const sentBatchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: unknown[] };
        sentBatchSizes.push(body.requests.length);
        return makeEmbeddingResponse(body.requests.length);
      },
    );
    const emb = new GeminiEmbeddings(VALID_OPTS);
    // 13,000-char text exceeds MAX_PER_TEXT_CHARS (6000); splits into 3 pieces
    const longText = "y".repeat(13_000);
    const result = await emb.generate([longText]);

    // All pieces sent (> 1 piece for 1 input text)
    const totalPiecesSent = sentBatchSizes.reduce((a, b) => a + b, 0);
    expect(totalPiecesSent).toBeGreaterThan(1);
    expect(result).toHaveLength(1);
  });

  test("batches many texts to stay under token budget", async () => {
    const fetchCalls: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: unknown[] };
        fetchCalls.push(body.requests.length);
        return makeEmbeddingResponse(body.requests.length);
      },
    );
    const emb = new GeminiEmbeddings(VALID_OPTS);
    // 10 texts each 6000 chars → total 60,000 chars; MAX_BATCH_CHARS=54,000 → multiple batches
    const texts = Array.from({ length: 10 }, () => "b".repeat(6_000));
    const result = await emb.generate(texts);

    expect(result).toHaveLength(10);
    expect(fetchCalls.length).toBeGreaterThan(1);
    expect(fetchCalls.reduce((a, b) => a + b, 0)).toBe(10);
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const emb = new GeminiEmbeddings(VALID_OPTS);
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });
});
