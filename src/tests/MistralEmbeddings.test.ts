import { afterEach, describe, expect, mock, test } from "bun:test";
import { MistralEmbeddings } from "../embeddings/MistralEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

const VALID_OPTS = { model: "codestral-embed", apiKey: "my-key" };

function makeMistralResponse(batchSize: number) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: batchSize }, (_, i) => ({
        index: i,
        embedding: [i + 1, 0],
      })),
    }),
    { status: 200 },
  );
}

describe("MistralEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () => new MistralEmbeddings({ model: "codestral-embed", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new MistralEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown Mistral model");
  });

  test("dimensions is 1024 for codestral-embed", () => {
    const emb = new MistralEmbeddings(VALID_OPTS);
    expect(emb.dimensions).toBe(1024);
  });

  test("returns vectors for a small batch", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        return makeMistralResponse(body.input.length);
      },
    );
    const emb = new MistralEmbeddings(VALID_OPTS);
    const result = await emb.generate(["foo", "bar"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1, 0]);
    expect(result[1]).toEqual([2, 0]);
  });

  test("batch size never exceeds 128", async () => {
    const batchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        batchSizes.push(body.input.length);
        return makeMistralResponse(body.input.length);
      },
    );
    const emb = new MistralEmbeddings(VALID_OPTS);
    const texts = Array.from({ length: 200 }, () => "short");
    await emb.generate(texts);

    expect(batchSizes.every((s) => s <= 128)).toBe(true);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(200);
  });

  test("splits oversized text and returns one averaged vector", async () => {
    const sentBatchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        sentBatchSizes.push(body.input.length);
        return makeMistralResponse(body.input.length);
      },
    );
    const emb = new MistralEmbeddings(VALID_OPTS);
    // 50,000-char text exceeds MAX_PER_TEXT_CHARS (24,000); splits into 3 pieces
    const longText = "z".repeat(50_000);
    const result = await emb.generate([longText]);

    // All pieces sent (> 1 piece for 1 input text)
    const totalPiecesSent = sentBatchSizes.reduce((a, b) => a + b, 0);
    expect(totalPiecesSent).toBeGreaterThan(1);
    expect(result).toHaveLength(1);
  });

  test("batches many texts to stay under char budget", async () => {
    const fetchCalls: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        fetchCalls.push(body.input.length);
        return makeMistralResponse(body.input.length);
      },
    );
    const emb = new MistralEmbeddings(VALID_OPTS);
    // 4 texts × 24,000 chars = 96,000 chars total; MAX_BATCH_CHARS=45,000 → multiple batches
    const texts = Array.from({ length: 4 }, () => "c".repeat(24_000));
    const result = await emb.generate(texts);

    expect(result).toHaveLength(4);
    expect(fetchCalls.length).toBeGreaterThan(1);
    expect(fetchCalls.reduce((a, b) => a + b, 0)).toBe(4);
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const emb = new MistralEmbeddings(VALID_OPTS);
    await expect(emb.generate(["test"])).rejects.toThrow("403");
  });
});
