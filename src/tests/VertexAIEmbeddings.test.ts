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
    // 5,000-char text exceeds MAX_PER_TEXT_CHARS (2000); splits into 3 pieces
    const longText = "x".repeat(5_000);
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
    // 10 texts each 2000 chars = 20,000 chars total → must split into multiple batches
    // MAX_BATCH_CHARS = 18,000 so 9 texts fit per batch (18,000 chars), 1 in second
    const texts = Array.from({ length: 10 }, () => "a".repeat(2_000));
    const result = await emb.generate(texts);

    expect(result).toHaveLength(10);
    expect(fetchCalls.length).toBeGreaterThan(1);
    const totalItems = fetchCalls.reduce((a, b) => a + b, 0);
    expect(totalItems).toBe(10);
  });

  test("generate() sends task_type RETRIEVAL_DOCUMENT", async () => {
    let captured: { instances: { task_type: string }[] } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeVertexResponse(captured?.instances.length ?? 0);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await emb.generate(["some code"]);
    expect(captured?.instances[0]?.task_type).toBe("RETRIEVAL_DOCUMENT");
  });

  test("embedQuery() sends task_type CODE_RETRIEVAL_QUERY", async () => {
    let captured:
      | { instances: { task_type: string; content: string }[] }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeVertexResponse(captured?.instances.length ?? 0);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    const v = await emb.embedQuery("how does auth work");
    expect(captured?.instances[0]?.task_type).toBe("CODE_RETRIEVAL_QUERY");
    expect(captured?.instances[0]?.content).toBe("how does auth work");
    expect(v).toEqual([1, 0]);
  });

  test("dimensions defaults to 256 for gemini-embedding-001", () => {
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
    });
    expect(emb.dimensions).toBe(256);
  });

  test("explicit dimensions override the default for gemini-embedding-001", () => {
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
      dimensions: 3072,
    });
    expect(emb.dimensions).toBe(3072);
  });

  test("gemini-embedding-001 sends one text per request (no batching)", async () => {
    const fetchCalls: { instancesLen: number; task_type: string }[] = [];
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          instances: { task_type: string }[];
        };
        fetchCalls.push({
          instancesLen: body.instances.length,
          task_type: body.instances[0]?.task_type ?? "",
        });
        return makeVertexResponse(body.instances.length);
      },
    );
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
    });
    const result = await emb.generate(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.every((c) => c.instancesLen === 1)).toBe(true);
    expect(fetchCalls.every((c) => c.task_type === "RETRIEVAL_DOCUMENT")).toBe(
      true,
    );
  });

  test("explicit dimensions puts outputDimensionality in parameters", async () => {
    let captured:
      | { parameters?: { outputDimensionality?: number } }
      | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            predictions: [
              { embeddings: { values: Array.from({ length: 256 }, () => 1) } },
            ],
          }),
          { status: 200 },
        );
      },
    );
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
      dimensions: 256,
    });
    await emb.generate(["hi"]);
    expect(captured?.parameters?.outputDimensionality).toBe(256);
  });

  test("sub-native dimensions produce L2-normalized unit vectors", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            predictions: [{ embeddings: { values: [3, 4, 0, 0] } }],
          }),
          { status: 200 },
        ),
    );
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
      dimensions: 4,
    });
    const [v] = await emb.generate(["x"]);
    const norm = Math.sqrt((v ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test("native dimensions omit parameters block", async () => {
    let captured: { parameters?: unknown } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeVertexResponse(1);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await emb.generate(["x"]);
    expect(captured?.parameters).toBeUndefined();
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

  test("retries on 429 and succeeds on second attempt", async () => {
    let calls = 0;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          return new Response("Rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        const body = JSON.parse(init.body as string) as {
          instances: unknown[];
        };
        return makeVertexResponse(body.instances.length);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    const result = await emb.generate(["hello"]);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  test("retries on 5xx and succeeds on retry", async () => {
    let calls = 0;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          return new Response("Service Unavailable", {
            status: 503,
            headers: { "retry-after": "0" },
          });
        }
        const body = JSON.parse(init.body as string) as {
          instances: unknown[];
        };
        return makeVertexResponse(body.instances.length);
      },
    );
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    const result = await emb.generate(["hello"]);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  test("gives up on persistent 4xx (non-429) without retrying", async () => {
    let calls = 0;
    (globalThis as Record<string, unknown>).fetch = mock(async () => {
      calls++;
      return new Response("Bad Request", { status: 400 });
    });
    const emb = new VertexAIEmbeddings(VALID_OPTS);
    await expect(emb.generate(["hello"])).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  test("dispatches gemini-embedding-001 requests concurrently", async () => {
    let inFlight = 0;
    let peakConcurrency = 0;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        inFlight++;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        const body = JSON.parse(init.body as string) as {
          instances: unknown[];
        };
        const res = makeVertexResponse(body.instances.length);
        inFlight--;
        return res;
      },
    );
    const emb = new VertexAIEmbeddings({
      model: "gemini-embedding-001",
      project: "proj",
      concurrency: 4,
    });
    // 6 texts × 1 instance/request = 6 sequential-in-serial, parallel-in-concurrent
    await emb.generate(["a", "b", "c", "d", "e", "f"]);
    expect(peakConcurrency).toBeGreaterThan(1);
    expect(peakConcurrency).toBeLessThanOrEqual(4);
  });
});
