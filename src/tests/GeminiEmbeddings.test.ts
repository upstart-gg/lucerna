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

  test("dimensions defaults to 256 for gemini-embedding-001", () => {
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(256);
  });

  test("dimensions defaults to 256 for gemini-embedding-2-preview", () => {
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-2-preview",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(256);
  });

  test("explicit dimensions override the default", () => {
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "key",
      dimensions: 3072,
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
    // 5,000-char text exceeds MAX_PER_TEXT_CHARS (2000); splits into 3 pieces
    const longText = "y".repeat(5_000);
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
    // 10 texts each 2000 chars = 20,000 chars total → must split into multiple batches
    // MAX_BATCH_CHARS = 18,000 so 9 texts fit per batch (18,000 chars), 1 in second
    const texts = Array.from({ length: 10 }, () => "b".repeat(2_000));
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

  test("generate() sends taskType RETRIEVAL_DOCUMENT on gemini-embedding-001", async () => {
    let captured:
      | {
          requests: {
            taskType?: string;
            content: { parts: { text: string }[] };
          }[];
        }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeEmbeddingResponse(captured?.requests.length ?? 0);
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "k",
    });
    await emb.generate(["hello"]);
    expect(captured?.requests[0]?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(captured?.requests[0]?.content.parts[0]?.text).toBe("hello");
  });

  test("embedQuery() sends taskType CODE_RETRIEVAL_QUERY on gemini-embedding-001", async () => {
    let captured:
      | {
          requests: {
            taskType?: string;
            content: { parts: { text: string }[] };
          }[];
        }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeEmbeddingResponse(captured?.requests.length ?? 0);
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "k",
    });
    await emb.embedQuery("how does auth work");
    expect(captured?.requests[0]?.taskType).toBe("CODE_RETRIEVAL_QUERY");
    expect(captured?.requests[0]?.content.parts[0]?.text).toBe(
      "how does auth work",
    );
  });

  test("generate() on gemini-embedding-2-preview omits taskType and sends text as-is", async () => {
    let captured:
      | {
          requests: {
            taskType?: string;
            content: { parts: { text: string }[] };
          }[];
        }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeEmbeddingResponse(captured?.requests.length ?? 0);
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-2-preview",
      apiKey: "k",
    });
    await emb.generate(["function foo() {}"]);
    expect(captured?.requests[0]?.taskType).toBeUndefined();
    expect(captured?.requests[0]?.content.parts[0]?.text).toBe(
      "function foo() {}",
    );
  });

  test("embedQuery() on gemini-embedding-2-preview omits taskType and prepends code-retrieval prefix", async () => {
    let captured:
      | {
          requests: {
            taskType?: string;
            content: { parts: { text: string }[] };
          }[];
        }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeEmbeddingResponse(captured?.requests.length ?? 0);
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-2-preview",
      apiKey: "k",
    });
    await emb.embedQuery("how does auth work");
    expect(captured?.requests[0]?.taskType).toBeUndefined();
    expect(captured?.requests[0]?.content.parts[0]?.text).toBe(
      "task: code retrieval | query: how does auth work",
    );
  });

  test("explicit dimensions: 256 passes outputDimensionality in the request body", async () => {
    let captured: { requests: { outputDimensionality?: number }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        // Return a 256-dim vector (arbitrary values) so we can validate normalization
        return new Response(
          JSON.stringify({
            embeddings: [{ values: Array.from({ length: 256 }, () => 2) }],
          }),
          { status: 200 },
        );
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-2-preview",
      apiKey: "k",
      dimensions: 256,
    });
    await emb.generate(["hi"]);
    expect(captured?.requests[0]?.outputDimensionality).toBe(256);
  });

  test("sub-native dimensions produce L2-normalized unit vectors", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            // Unnormalized, length != 1
            embeddings: [{ values: [3, 4, 0, 0] }],
          }),
          { status: 200 },
        ),
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-2-preview",
      apiKey: "k",
      dimensions: 4,
    });
    const [v] = await emb.generate(["x"]);
    const norm = Math.sqrt((v ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(v).toHaveLength(4);
  });

  test("native dimensions skip outputDimensionality and normalization", async () => {
    let captured: { requests: { outputDimensionality?: number }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        // Return unnormalized vector to prove we don't post-process
        return new Response(
          JSON.stringify({ embeddings: [{ values: [3, 4, 0] }] }),
          { status: 200 },
        );
      },
    );
    const emb = new GeminiEmbeddings({
      model: "text-embedding-004",
      apiKey: "k",
    });
    const [v] = await emb.generate(["x"]);
    expect(captured?.requests[0]?.outputDimensionality).toBeUndefined();
    // Not re-normalized client-side
    expect(v).toEqual([3, 4, 0]);
  });

  test("gemini-embedding-001 at default dim sends outputDimensionality: 256", async () => {
    let captured: { requests: { outputDimensionality?: number }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            embeddings: [{ values: Array.from({ length: 256 }, () => 1) }],
          }),
          { status: 200 },
        );
      },
    );
    const emb = new GeminiEmbeddings({
      model: "gemini-embedding-001",
      apiKey: "k",
    });
    await emb.generate(["x"]);
    expect(captured?.requests[0]?.outputDimensionality).toBe(256);
  });
});
