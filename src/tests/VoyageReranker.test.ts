import { afterEach, describe, expect, mock, test } from "bun:test";
import { VoyageReranker } from "../embeddings/VoyageReranker.js";

const REAL_FETCH = globalThis.fetch;

describe("VoyageReranker — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(() => new VoyageReranker({ apiKey: "" })).toThrow(
      "lucerna.config.ts",
    );
  });

  test("returns scores in original input order", async () => {
    // API returns results sorted by score desc; index points to original position
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, relevance_score: 0.92 },
              { index: 0, relevance_score: 0.31 },
            ],
          }),
          { status: 200 },
        ),
    );

    const reranker = new VoyageReranker({ apiKey: "test-key" });
    const scores = await reranker.rerank("query", ["text one", "text two"]);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toBeCloseTo(0.31); // index:0 = "text one"
    expect(scores[1]).toBeCloseTo(0.92); // index:1 = "text two"
  });

  test("sends correct request body and headers", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: [
              { index: 0, relevance_score: 0.9 },
              { index: 1, relevance_score: 0.5 },
            ],
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({ apiKey: "my-voyage-key" });
    await reranker.rerank("find auth", ["function auth() {}", "const x = 1"]);

    expect(capturedUrl).toBe("https://api.voyageai.com/v1/rerank");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer my-voyage-key");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      model: "rerank-2.5",
      query: "find auth",
      documents: ["function auth() {}", "const x = 1"],
      return_documents: false,
    });
  });

  test("default model rerank-2.5 is used when none specified", async () => {
    let capturedBody: { model: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, relevance_score: 0.8 }] }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    await reranker.rerank("query", ["text"]);
    expect(capturedBody?.model).toBe("rerank-2.5");
  });

  test("custom model is sent in request body", async () => {
    let capturedBody: { model: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, relevance_score: 0.7 }] }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({
      apiKey: "key",
      model: "rerank-lite-1",
    });
    await reranker.rerank("query", ["text"]);
    expect(capturedBody?.model).toBe("rerank-lite-1");
  });

  test("returns empty array without calling fetch for empty input", async () => {
    let fetchCalled = false;
    (globalThis as Record<string, unknown>).fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const reranker = new VoyageReranker({ apiKey: "key" });
    const scores = await reranker.rerank("query", []);

    expect(scores).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    await expect(reranker.rerank("q", ["text"])).rejects.toThrow("401");
  });

  test("truncates document over MAX_DOC_CHARS using head+tail", async () => {
    let capturedBody: { documents: string[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, relevance_score: 0.5 }] }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    const longDoc = "x".repeat(10_000); // exceeds MAX_DOC_CHARS (8000)
    await reranker.rerank("query", [longDoc]);

    const sentDoc = capturedBody?.documents[0] ?? "";
    expect(sentDoc.length).toBeLessThanOrEqual(8_000);
    expect(sentDoc).toContain("/* … */");
  });

  test("documents within MAX_DOC_CHARS are sent unchanged", async () => {
    let capturedBody: { documents: string[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, relevance_score: 0.8 }] }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    const shortDoc = "hello world";
    await reranker.rerank("query", [shortDoc]);

    expect(capturedBody?.documents[0]).toBe(shortDoc);
  });

  test("truncates query over MAX_QUERY_CHARS", async () => {
    let capturedBody: { query: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, relevance_score: 0.5 }] }),
          { status: 200 },
        );
      },
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    const longQuery = "q".repeat(30_000); // exceeds MAX_QUERY_CHARS (24000)
    await reranker.rerank(longQuery, ["doc"]);

    expect((capturedBody?.query ?? "").length).toBeLessThanOrEqual(24_000);
    expect(capturedBody?.query).toContain("/* … */");
  });

  test("preserves order — scores[i] corresponds to texts[i]", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, relevance_score: 0.95 },
              { index: 0, relevance_score: 0.05 },
            ],
          }),
          { status: 200 },
        ),
    );

    const reranker = new VoyageReranker({ apiKey: "key" });
    const scores = await reranker.rerank("q", ["irrelevant", "relevant"]);

    expect(scores[0]).toBeCloseTo(0.05);
    expect(scores[1]).toBeCloseTo(0.95);
  });
});

const SKIP_INTEGRATION =
  process.env.INTEGRATION_TESTS !== "1" || !process.env.VOYAGE_API_KEY;

describe.skipIf(SKIP_INTEGRATION)("VoyageReranker — integration", () => {
  test("returns one score per input text", async () => {
    const reranker = new VoyageReranker();
    const texts = ["function authenticate() {}", "const PI = 3.14"];
    const scores = await reranker.rerank("authentication", texts);
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("more relevant text scores higher", async () => {
    const reranker = new VoyageReranker();
    const scores = await reranker.rerank("fibonacci recursive function", [
      "const DB_HOST = 'localhost'; const DB_PORT = 5432;",
      "function fibonacci(n) { if (n <= 1) return n; return fibonacci(n - 1) + fibonacci(n - 2); }",
    ]);
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
  });
});
