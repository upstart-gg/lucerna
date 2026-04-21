import { afterEach, describe, expect, mock, test } from "bun:test";
import { JinaEmbeddings } from "../embeddings/JinaEmbeddings.js";

const REAL_FETCH = globalThis.fetch;

function makeResponse(batchSize: number, embedding: number[] = [1, 0]) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: batchSize }, (_, i) => ({
        index: i,
        embedding,
      })),
    }),
    { status: 200 },
  );
}

describe("JinaEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () => new JinaEmbeddings({ model: "jina-embeddings-v3", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new JinaEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown Jina model");
  });

  test("dimensions defaults to 512 for jina-embeddings-v3", () => {
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v3",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(512);
  });

  test("dimensions defaults to 768 for jina-embeddings-v2-base-en (no MRL)", () => {
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v2-base-en",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(768);
  });

  test("explicit dimensions override the default", () => {
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v3",
      apiKey: "key",
      dimensions: 1024,
    });
    expect(emb.dimensions).toBe(1024);
  });

  test("default dim sends dimensions + task=retrieval.passage", async () => {
    let captured: { dimensions?: number; task?: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [3, 4, 0, 0] }],
          }),
          { status: 200 },
        );
      },
    );
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v3",
      apiKey: "k",
    });
    const [v] = await emb.generate(["x"]);
    expect(captured?.dimensions).toBe(512);
    expect(captured?.task).toBe("retrieval.passage");
    const norm = Math.sqrt((v ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test("embedQuery sends task=retrieval.query", async () => {
    let captured: { task?: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeResponse(1);
      },
    );
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v3",
      apiKey: "k",
    });
    await emb.embedQuery("how does auth work");
    expect(captured?.task).toBe("retrieval.query");
  });

  test("native dim (v2) omits dimensions param and skips L2 norm", async () => {
    let captured: { dimensions?: number } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [3, 4, 0] }] }),
          { status: 200 },
        );
      },
    );
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v2-base-en",
      apiKey: "k",
    });
    const [v] = await emb.generate(["x"]);
    expect(captured?.dimensions).toBeUndefined();
    expect(v).toEqual([3, 4, 0]);
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const emb = new JinaEmbeddings({
      model: "jina-embeddings-v3",
      apiKey: "k",
    });
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });
});
