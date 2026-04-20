import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _clearVertexAuthCache } from "../embeddings/vertexAuth.js";
import { VertexAIEmbeddings } from "../embeddings/VertexAIEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

// Mock google-auth-library so tests don't need real GCP credentials
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = mock(async () => ({
      getAccessToken: mock(async () => ({ token: "test-access-token" })),
    }));
  },
}));

const VALID_OPTS = {
  model: "text-embedding-005",
  project: "my-project",
};

function makeVertexResponse(batchSize: number) {
  return new Response(
    JSON.stringify({
      predictions: Array.from({ length: batchSize }, (_, i) => ({
        embeddings: { values: [i + 1, 0] },
      })),
    }),
    { status: 200 },
  );
}

describe("VertexAIEmbeddings — unit", () => {
  beforeEach(() => {
    _clearVertexAuthCache();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
    _clearVertexAuthCache();
  });

  test("throws if project is missing", () => {
    expect(
      () =>
        new VertexAIEmbeddings({
          model: "text-embedding-005",
        }),
    ).toThrow("project is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () =>
        new VertexAIEmbeddings({
          model: "unknown-model",
          project: "proj",
        }),
    ).toThrow("unknown model");
  });

  test("dimensions defaults to 768 for text-embedding-005", () => {
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    expect(emb.dimensions).toBe(768);
  });

  test("returns vectors for a small batch in a single request", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          instances: unknown[];
        };
        return makeVertexResponse(body.instances.length);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    const result = await emb.generate(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1, 0]);
    expect(result[1]).toEqual([2, 0]);
  });

  test("sends correct URL and Bearer auth header", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return makeVertexResponse(1);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await emb.generate(["test"]);
    expect(capturedUrl).toContain("my-project");
    expect(capturedUrl).toContain("text-embedding-005");
    expect(capturedHeaders?.Authorization).toBe("Bearer test-access-token");
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
    // 13,000-char text exceeds MAX_PER_TEXT_CHARS (4000); splits into 4 pieces
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
    // 10 texts each 4000 chars = 40,000 chars total → must split into multiple batches
    // MAX_BATCH_CHARS = 36,000 so 9 texts fit per batch (36,000 chars), 1 in second
    const texts = Array.from({ length: 10 }, () => "a".repeat(4_000));
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
