import { afterEach, describe, expect, mock, test } from "bun:test";
import { VertexAIEmbeddings } from "../embeddings/VertexAIEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

const VALID_OPTS = {
  model: "text-embedding-005",
  project: "my-project",
  accessToken: "my-token",
};

function makeFetch(vectors: number[][][] | null = null, status = 200) {
  let callCount = 0;
  return mock(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      instances: { content: string }[];
    };
    const batchSize = body.instances.length;
    const data =
      vectors?.[callCount++] ??
      Array.from({ length: batchSize }, (_, i) => [i + 1, 0]);
    return new Response(
      JSON.stringify({
        predictions: data.map((v) => ({ embeddings: { values: v } })),
      }),
      { status, statusText: status === 200 ? "OK" : "Bad Request" },
    );
  });
}

describe("VertexAIEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if project is missing", () => {
    expect(
      () =>
        new VertexAIEmbeddings({
          model: "text-embedding-005",
          accessToken: "token",
        }),
    ).toThrow("project is required");
  });

  test("throws if accessToken is missing", () => {
    expect(
      () =>
        new VertexAIEmbeddings({
          model: "text-embedding-005",
          project: "proj",
        }),
    ).toThrow("accessToken is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () =>
        new VertexAIEmbeddings({
          model: "unknown-model",
          project: "proj",
          accessToken: "tok",
        }),
    ).toThrow("unknown model");
  });

  test("dimensions defaults to 768 for text-embedding-005", () => {
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    expect(emb.dimensions).toBe(768);
  });

  test("returns vectors for a small batch in a single request", async () => {
    (globalThis as Record<string, unknown>).fetch = makeFetch([
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    ]);
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    const result = await emb.generate(["hello", "world"]);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  test("sends correct URL and auth header", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            predictions: [{ embeddings: { values: [0.1] } }],
          }),
          { status: 200 },
        );
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await emb.generate(["test"]);
    expect(capturedUrl).toContain("my-project");
    expect(capturedUrl).toContain("text-embedding-005");
    expect(capturedHeaders?.Authorization).toBe("Bearer my-token");
  });

  test("splits oversized text into pieces and returns one averaged vector", async () => {
    const sentBatchSizes: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          instances: { content: string }[];
        };
        sentBatchSizes.push(body.instances.length);
        const data = body.instances.map((_, i) => [i + 1]);
        return new Response(
          JSON.stringify({
            predictions: data.map((v) => ({ embeddings: { values: v } })),
          }),
          { status: 200 },
        );
      },
    );

    const emb = new VertexAIEmbeddings(VALID_OPTS);
    // 13,000-char text exceeds MAX_PER_TEXT_CHARS (6000); splits into 3 pieces
    const longText = "x".repeat(13_000);
    const result = await emb.generate([longText]);

    // All pieces sent (> 1 piece for 1 input text)
    const totalPiecesSent = sentBatchSizes.reduce((a, b) => a + b, 0);
    expect(totalPiecesSent).toBeGreaterThan(1);
    // Only one vector returned for the single input text
    expect(result).toHaveLength(1);
  });

  test("batches many texts to stay under token budget", async () => {
    const fetchCalls: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          instances: { content: string }[];
        };
        fetchCalls.push(body.instances.length);
        const data = body.instances.map((_, i) => [i]);
        return new Response(
          JSON.stringify({
            predictions: data.map((v) => ({ embeddings: { values: v } })),
          }),
          { status: 200 },
        );
      },
    );

    const emb = new VertexAIEmbeddings(VALID_OPTS);
    // 10 texts each 6000 chars = 60,000 chars total → must split into multiple batches
    // MAX_BATCH_CHARS = 54,000 so ~9 texts fit per batch
    const texts = Array.from({ length: 10 }, () => "a".repeat(6_000));
    const result = await emb.generate(texts);

    expect(result).toHaveLength(10);
    expect(fetchCalls.length).toBeGreaterThan(1);
    const totalItems = fetchCalls.reduce((a, b) => a + b, 0);
    expect(totalItems).toBe(10);
  });

  test("throws on API error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Token limit exceeded", {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await expect(emb.generate(["test"])).rejects.toThrow("400");
  });
});
