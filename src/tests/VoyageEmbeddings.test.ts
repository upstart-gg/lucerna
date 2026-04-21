import { afterEach, describe, expect, mock, test } from "bun:test";
import { VoyageEmbeddings } from "../embeddings/VoyageEmbeddings.js";

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

describe("VoyageEmbeddings — unit", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = REAL_FETCH;
  });

  test("throws if apiKey is missing", () => {
    expect(
      () => new VoyageEmbeddings({ model: "voyage-code-3", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  test("throws for unknown model without explicit dimensions", () => {
    expect(
      () => new VoyageEmbeddings({ model: "unknown-model", apiKey: "key" }),
    ).toThrow("Unknown Voyage model");
  });

  test("dimensions defaults to 512 for voyage-code-3", () => {
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(512);
  });

  test("dimensions defaults to 512 for voyage-3", () => {
    const emb = new VoyageEmbeddings({ model: "voyage-3", apiKey: "key" });
    expect(emb.dimensions).toBe(512);
  });

  test("dimensions defaults to 1024 for voyage-3-large", () => {
    const emb = new VoyageEmbeddings({
      model: "voyage-3-large",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(1024);
  });

  test("dimensions defaults to 512 for voyage-3-lite (native=512)", () => {
    const emb = new VoyageEmbeddings({
      model: "voyage-3-lite",
      apiKey: "key",
    });
    expect(emb.dimensions).toBe(512);
  });

  test("explicit dimensions override the default", () => {
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "key",
      dimensions: 1024,
    });
    expect(emb.dimensions).toBe(1024);
  });

  test("default dim sends output_dimension + input_type=document", async () => {
    let captured:
      | { output_dimension?: number; input_type?: string }
      | undefined;
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
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "k",
    });
    const [v] = await emb.generate(["x"]);
    expect(captured?.output_dimension).toBe(512);
    expect(captured?.input_type).toBe("document");
    const norm = Math.sqrt((v ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test("embedQuery sends input_type=query", async () => {
    let captured: { input_type?: string } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return makeResponse(1);
      },
    );
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "k",
    });
    await emb.embedQuery("how does auth work");
    expect(captured?.input_type).toBe("query");
  });

  test("native dim omits output_dimension and skips L2 norm", async () => {
    let captured: { output_dimension?: number } | undefined;
    (globalThis as Record<string, unknown>).fetch = mock(
      async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [3, 4, 0] }] }),
          { status: 200 },
        );
      },
    );
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "k",
      dimensions: 1024,
    });
    const [v] = await emb.generate(["x"]);
    expect(captured?.output_dimension).toBeUndefined();
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
    const emb = new VoyageEmbeddings({
      model: "voyage-code-3",
      apiKey: "k",
    });
    await expect(emb.generate(["test"])).rejects.toThrow("401");
  });
});
