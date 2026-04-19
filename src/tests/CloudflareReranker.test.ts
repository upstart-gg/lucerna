import { afterEach, describe, expect, mock, test } from "bun:test";
import { CloudflareReranker } from "../embeddings/CloudflareReranker.js";

// ---------------------------------------------------------------------------
// Unit tests — no network calls
// ---------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;

describe("CloudflareReranker — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if accountId is missing", () => {
    expect(
      () => new CloudflareReranker({ accountId: "", apiToken: "token" }),
    ).toThrow("accountId is required");
  });

  test("throws if apiToken is missing", () => {
    expect(
      () => new CloudflareReranker({ accountId: "account", apiToken: "" }),
    ).toThrow("apiToken is required");
  });

  test("returns scores on success in original input order", async () => {
    // API returns sorted by score desc, with id pointing to original index
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              response: [
                { id: 1, score: 0.92 }, // second input scored higher
                { id: 0, score: 0.31 }, // first input scored lower
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    const scores = await reranker.rerank("query", ["text one", "text two"]);

    expect(scores).toHaveLength(2);
    // scores[0] corresponds to "text one" (id:0 → 0.31)
    expect(scores[0]).toBeCloseTo(0.31);
    // scores[1] corresponds to "text two" (id:1 → 0.92)
    expect(scores[1]).toBeCloseTo(0.92);
  });

  test("scores are in 0–1 range", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              response: [
                { id: 0, score: 0.99 },
                { id: 1, score: 0.01 },
                { id: 2, score: 0.5 },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    const scores = await reranker.rerank("q", ["a", "b", "c"]);

    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("sends correct request body format", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              response: [
                { id: 0, score: 0.9 },
                { id: 1, score: 0.5 },
              ],
            },
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new CloudflareReranker({
      accountId: "my-account",
      apiToken: "my-token",
    });
    await reranker.rerank("find auth", ["function auth() {}", "const x = 1"]);

    expect(capturedUrl).toContain("my-account");
    expect(capturedUrl).toContain("bge-reranker-base");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer my-token");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      query: "find auth",
      contexts: [{ text: "function auth() {}" }, { text: "const x = 1" }],
    });
  });

  test("returns empty array for empty input without calling fetch", async () => {
    let fetchCalled = false;
    (globalThis as Record<string, unknown>).fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
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

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    await expect(reranker.rerank("q", ["text"])).rejects.toThrow("401");
  });

  test("throws on API-level error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "bad model" }],
            result: { response: [] },
          }),
          { status: 200 },
        ),
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    await expect(reranker.rerank("q", ["text"])).rejects.toThrow("bad model");
  });

  test("short text is sent unchanged", async () => {
    const shortText = "function greet() { return 'hi'; }";
    let capturedBody: { contexts: { text: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            success: true,
            result: { response: [{ id: 0, score: 0.8 }] },
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    await reranker.rerank("query", [shortText]);
    expect(capturedBody?.contexts[0]?.text).toBe(shortText);
  });

  test("long text is truncated using head+tail strategy", async () => {
    // Construct text with distinct head, middle, and tail sections
    const head = "A".repeat(1100);
    const middle = "MIDDLE_SECTION";
    const tail = "Z".repeat(1000);
    const longText = head + middle + tail;

    let capturedBody: { contexts: { text: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            success: true,
            result: { response: [{ id: 0, score: 0.5 }] },
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    await reranker.rerank("query", [longText]);

    const sent = capturedBody?.contexts[0]?.text ?? "";
    expect(sent.length).toBeLessThanOrEqual(2050); // within budget
    expect(sent.startsWith("A")).toBe(true); // head preserved
    expect(sent.endsWith("Z")).toBe(true); // tail preserved
    expect(sent).not.toContain("MIDDLE_SECTION"); // middle removed
    expect(sent).toContain("/* … */"); // marker present
  });

  test("text at exactly MAX_RERANKER_CHARS is not truncated", async () => {
    const exactText = "X".repeat(2048);
    let capturedBody: { contexts: { text: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            success: true,
            result: { response: [{ id: 0, score: 0.5 }] },
          }),
          { status: 200 },
        );
      },
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    await reranker.rerank("query", [exactText]);
    expect(capturedBody?.contexts[0]?.text).toBe(exactText); // sent as-is, no marker
  });

  test("preserves order — scores[i] corresponds to texts[i]", async () => {
    // API returns second input (id:1) first (higher score), first input (id:0) second
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              response: [
                { id: 1, score: 0.95 },
                { id: 0, score: 0.05 },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const reranker = new CloudflareReranker({
      accountId: "account",
      apiToken: "token",
    });
    const scores = await reranker.rerank("q", ["irrelevant", "relevant"]);

    // scores[0] = id:0 = 0.05 (irrelevant), scores[1] = id:1 = 0.95 (relevant)
    expect(scores[0]).toBeCloseTo(0.05);
    expect(scores[1]).toBeCloseTo(0.95);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real Cloudflare calls, only when INTEGRATION_TESTS=1
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION =
  process.env.INTEGRATION_TESTS !== "1" ||
  !process.env.CLOUDFLARE_ACCOUNT_ID ||
  !process.env.CLOUDFLARE_API_TOKEN;

describe.skipIf(SKIP_INTEGRATION)("CloudflareReranker — integration", () => {
  test("returns one score per input text", async () => {
    const reranker = new CloudflareReranker({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    });
    const texts = ["function authenticate() {}", "const PI = 3.14"];
    const scores = await reranker.rerank("authentication", texts);
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    }
  });

  test("more relevant text scores higher", async () => {
    const reranker = new CloudflareReranker({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    });
    const scores = await reranker.rerank("fibonacci recursive function", [
      "const DB_HOST = 'localhost'; const DB_PORT = 5432;",
      "function fibonacci(n) { if (n <= 1) return n; return fibonacci(n - 1) + fibonacci(n - 2); }",
    ]);
    // second text (fibonacci implementation) must score higher than the DB config constant
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
  });
});
