import { afterEach, describe, expect, mock, test } from "bun:test";
import { OpenAIEmbeddings } from "../embeddings/OpenAIEmbeddings.js";

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

describe("OpenAIEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () =>
        new OpenAIEmbeddings({ model: "text-embedding-3-small", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new OpenAIEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown OpenAI model");
  });

  test("dimensions defaults to 512 for text-embedding-3-small", () => {
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(512);
  });

  test("dimensions defaults to 768 for text-embedding-3-large", () => {
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-large",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(768);
  });

  test("dimensions defaults to 1536 for text-embedding-ada-002 (no MRL)", () => {
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-ada-002",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(1536);
  });

  test("explicit dimensions override the default", () => {
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: "key",
      dimensions: 1536,
    });
    expect(emb.dimensions).toBe(1536);
  });

  test("default dim forwards dimensions param to API", async () => {
    let captured: { dimensions?: number } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeResponse(1);
      },
    );
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: "k",
    });
    await emb.generate(["x"]);
    expect(captured?.dimensions).toBe(512);
  });

  test("native dim omits dimensions param", async () => {
    let captured: { dimensions?: number } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeResponse(1);
      },
    );
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: "k",
      dimensions: 1536,
    });
    await emb.generate(["x"]);
    expect(captured?.dimensions).toBeUndefined();
  });

  test("ada-002 at default omits dimensions param", async () => {
    let captured: { dimensions?: number } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeResponse(1);
      },
    );
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-ada-002",
      apiKey: "k",
    });
    await emb.generate(["x"]);
    expect(captured?.dimensions).toBeUndefined();
  });

  test("throws on HTTP error", async () => {
    (globalThis as Record<string, unknown>).fetch = mock(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const emb = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: "k",
    });
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });
});
