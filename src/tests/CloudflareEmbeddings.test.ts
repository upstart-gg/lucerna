import { afterEach, describe, expect, mock, test } from "bun:test";
import { CloudflareEmbeddings } from "../embeddings/CloudflareEmbeddings.js";

// ---------------------------------------------------------------------------
// Unit tests — no network calls
// ---------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;

describe("CloudflareEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if accountId is missing", () => {
    expect(() => new CloudflareEmbeddings("", "token")).toThrow(
      "CLOUDFLARE_ACCOUNT_ID",
    );
  });

  test("throws if apiToken is missing", () => {
    expect(() => new CloudflareEmbeddings("account", "")).toThrow(
      "CLOUDFLARE_API_TOKEN",
    );
  });

  test("returns vectors on success", async () => {
    const mockVectors = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ success: true, result: { data: mockVectors } }),
          { status: 200 },
        ),
    );

    const emb = new CloudflareEmbeddings("account", "token");
    const result = await emb.generate(["hello", "world"]);
    expect(result).toEqual(mockVectors);
  });

  test("sends correct request to the API", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({ success: true, result: { data: [[0.1]] } }),
          { status: 200 },
        );
      },
    );

    const emb = new CloudflareEmbeddings("my-account", "my-token");
    await emb.generate(["test input"]);

    expect(capturedUrl).toContain("my-account");
    expect(capturedUrl).toContain("@cf/baai/bge-m3");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer my-token");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      text: ["test input"],
    });
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );

    const emb = new CloudflareEmbeddings("account", "token");
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });

  test("throws on API-level error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "bad request" }],
            result: { data: [] },
          }),
          { status: 200 },
        ),
    );

    const emb = new CloudflareEmbeddings("account", "token");
    await expect(emb.generate(["test"])).rejects.toThrow("bad request");
  });

  test("dimensions is 1024", () => {
    const emb = new CloudflareEmbeddings("account", "token");
    expect(emb.dimensions).toBe(1024);
  });

  test("splits oversized text into pieces and averages vectors", async () => {
    const calls: string[][] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string[] };
        calls.push(body.text);
        // Return a distinct vector per text so we can verify averaging
        const data = body.text.map((_, i) => [calls.flat().length + i]);
        return new Response(
          JSON.stringify({ success: true, result: { data } }),
          { status: 200 },
        );
      },
    );

    const emb = new CloudflareEmbeddings("account", "token");
    // A text longer than MAX_TEXT_CHARS (4500) must be split across multiple requests
    const longText = "x".repeat(10_000);
    const result = await emb.generate([longText]);

    // Should have issued multiple fetch calls (one per piece)
    expect(calls.length).toBeGreaterThan(1);
    // Should return exactly one vector for the one input text
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real Cloudflare calls, only when INTEGRATION_TESTS=1
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = process.env.INTEGRATION_TESTS !== "1";

describe.skipIf(SKIP_INTEGRATION)("CloudflareEmbeddings — integration", () => {
  test("returns 1024-dim vectors for single text", async () => {
    const emb = new CloudflareEmbeddings();
    const result = await emb.generate(["function hello() { return 42; }"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1024);
  });

  test("returns vectors for batch input", async () => {
    const emb = new CloudflareEmbeddings();
    const texts = ["foo", "bar", "baz"];
    const result = await emb.generate(texts);
    expect(result).toHaveLength(3);
    for (const vec of result) {
      expect(vec).toHaveLength(1024);
    }
  });
});
