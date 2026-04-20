import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _clearVertexAuthCache } from "../embeddings/vertexAuth.js";
import { VertexAIReranker } from "../embeddings/VertexAIReranker.js";

const REAL_FETCH = globalThis.fetch;

mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = mock(async () => ({
      getAccessToken: mock(async () => ({ token: "test-access-token" })),
    }));
  },
}));

const VALID_OPTS = { project: "my-project" };

function makeRankResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({
      records: ids.map((id, i) => ({ id, score: ids.length - i })),
    }),
    { status: 200 },
  );
}

describe("VertexAIReranker — unit", () => {
  beforeEach(() => {
    _clearVertexAuthCache();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
    _clearVertexAuthCache();
  });

  test("throws if project is missing", () => {
    expect(() => new VertexAIReranker()).toThrow("project is required");
  });

  test("returns scores in original input order", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          records: { id: string }[];
        };
        // Return records in reverse order to test id remapping
        const reversed = [...body.records].reverse();
        return new Response(
          JSON.stringify({
            records: reversed.map((r, i) => ({ id: r.id, score: i + 1 })),
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    const scores = await reranker.rerank("query", ["text one", "text two"]);

    expect(scores).toHaveLength(2);
    // scores[0] corresponds to id "0", scores[1] to id "1"
    expect(typeof scores[0]).toBe("number");
    expect(typeof scores[1]).toBe("number");
  });

  test("sends correct URL, Bearer token, and request body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return makeRankResponse(["0", "1"]);
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    await reranker.rerank("find auth", ["function auth() {}", "const x = 1"]);

    expect(capturedUrl).toContain("my-project");
    expect(capturedUrl).toContain("rankingConfigs");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer test-access-token");
    const body = JSON.parse(capturedInit?.body as string) as {
      model: string;
      query: string;
      records: { id: string; content: string }[];
    };
    expect(body.model).toBe("semantic-ranker-default-004");
    expect(body.query).toBe("find auth");
    expect(body.records).toHaveLength(2);
    expect(body.records[0]?.id).toBe("0");
    expect(body.records[1]?.id).toBe("1");
  });

  test("returns empty array without calling fetch for empty input", async () => {
    let fetchCalled = false;
    (globalThis as Record<string, unknown>).fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const reranker = new VertexAIReranker(VALID_OPTS);
    const scores = await reranker.rerank("query", []);

    expect(scores).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  test("throws on API error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    await expect(reranker.rerank("q", ["text"])).rejects.toThrow("403");
  });

  test("truncates document over MAX_DOC_CHARS using head+tail", async () => {
    let capturedBody: { records: { content: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return makeRankResponse(["0"]);
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    const longDoc = "x".repeat(4_000); // exceeds MAX_DOC_CHARS (2000)
    await reranker.rerank("query", [longDoc]);

    const sentContent = capturedBody?.records[0]?.content ?? "";
    expect(sentContent.length).toBeLessThanOrEqual(2_000);
    expect(sentContent).toContain("/* … */");
  });

  test("documents within MAX_DOC_CHARS are sent unchanged", async () => {
    let capturedBody: { records: { content: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return makeRankResponse(["0"]);
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    const shortDoc = "function hello() {}";
    await reranker.rerank("query", [shortDoc]);

    expect(capturedBody?.records[0]?.content).toBe(shortDoc);
  });

  test("truncates query over MAX_QUERY_CHARS", async () => {
    let capturedBody: { query: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return makeRankResponse(["0"]);
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    const longQuery = "q".repeat(2_000); // exceeds MAX_QUERY_CHARS (500)
    await reranker.rerank(longQuery, ["doc"]);

    expect((capturedBody?.query ?? "").length).toBeLessThanOrEqual(500);
    expect(capturedBody?.query).toContain("/* … */");
  });

  test("batches 201 texts into 2 fetch calls", async () => {
    const fetchCalls: number[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          records: { id: string }[];
        };
        fetchCalls.push(body.records.length);
        return new Response(
          JSON.stringify({
            records: body.records.map((r) => ({ id: r.id, score: 1 })),
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new VertexAIReranker(VALID_OPTS);
    const texts = Array.from({ length: 201 }, (_, i) => `text ${i}`);
    const scores = await reranker.rerank("query", texts);

    expect(scores).toHaveLength(201);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toBe(200);
    expect(fetchCalls[1]).toBe(1);
  });
});
