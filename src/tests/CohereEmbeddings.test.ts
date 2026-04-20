import { afterEach, describe, expect, mock, test } from "bun:test";
import { CohereEmbeddings } from "../embeddings/CohereEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

const VALID_OPTS = { model: "embed-english-v3.0", apiKey: "my-key" };

function makeCohereResponse(batchSize: number) {
  return new Response(
    JSON.stringify({
      embeddings: {
        float: Array.from({ length: batchSize }, (_, i) => [i + 1, 0]),
      },
    }),
    { status: 200 },
  );
}

describe("CohereEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () => new CohereEmbeddings({ model: "embed-english-v3.0", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new CohereEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown Cohere model");
  });

  test("dimensions is 1024 for embed-english-v3.0", () => {
    const emb = new CohereEmbeddings(VALID_OPTS);
    expect(emb.dimensions).toBe(1024);
  });

  test("returns vectors for a small batch", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { texts: string[] };
        return makeCohereResponse(body.texts.length);
      },
    );
    const emb = new CohereEmbeddings(VALID_OPTS);
    const result = await emb.generate(["foo", "bar"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1, 0]);
    expect(result[1]).toEqual([2, 0]);
  });

  test("batch size never exceeds 96", async () => {
    const batchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { texts: string[] };
        batchSizes.push(body.texts.length);
        return makeCohereResponse(body.texts.length);
      },
    );
    const emb = new CohereEmbeddings(VALID_OPTS);
    const texts = Array.from({ length: 200 }, () => "short");
    await emb.generate(texts);

    expect(batchSizes.every((s) => s <= 96)).toBe(true);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(200);
  });

  test("splits oversized text (>1500 chars) and returns one averaged vector", async () => {
    const sentBatchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { texts: string[] };
        sentBatchSizes.push(body.texts.length);
        return makeCohereResponse(body.texts.length);
      },
    );
    const emb = new CohereEmbeddings(VALID_OPTS);
    // 4,000-char text exceeds MAX_PER_TEXT_CHARS (1500); splits into 3 pieces
    const longText = "a".repeat(4_000);
    const result = await emb.generate([longText]);

    // All pieces sent (> 1 piece for 1 input text)
    const totalPiecesSent = sentBatchSizes.reduce((a, b) => a + b, 0);
    expect(totalPiecesSent).toBeGreaterThan(1);
    // Only one vector returned for the single input text
    expect(result).toHaveLength(1);
  });

  test("sends input_type: search_document in request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        const body = capturedBody as { texts: string[] };
        return makeCohereResponse(body.texts.length);
      },
    );
    const emb = new CohereEmbeddings(VALID_OPTS);
    await emb.generate(["test"]);
    expect(capturedBody?.input_type).toBe("search_document");
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const emb = new CohereEmbeddings(VALID_OPTS);
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });
});
