import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers — same pattern as HFEmbeddings.test.ts
// ---------------------------------------------------------------------------

const mockDispose = mock(async () => {});

const mockPipelineInstance = Object.assign(
  mock(async (inputs: string[], _opts: unknown) => ({
    tolist: () => inputs.map((_: string) => new Array(768).fill(0.1)),
  })),
  { dispose: mockDispose },
);

const mockPipelineFactory = mock(
  async (_task: string, _model: string, _opts: unknown) => mockPipelineInstance,
);

mock.module("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: { allowLocalModels: true },
}));

// Import AFTER mock.module() registration.
import { NomicCodeEmbeddings } from "../embeddings/NomicCodeEmbeddings.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NomicCodeEmbeddings", () => {
  beforeEach(() => {
    mockPipelineInstance.mockClear();
    mockPipelineFactory.mockClear();
    mockDispose.mockClear();
  });

  test("dimensions is 768", () => {
    expect(new NomicCodeEmbeddings().dimensions).toBe(768);
  });

  test("generate() returns 768-dimensional vectors", async () => {
    const e = new NomicCodeEmbeddings();
    const result = await e.generate(["some code"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);
  });

  test("generate() returns multiple 768-dim vectors for multiple inputs", async () => {
    const e = new NomicCodeEmbeddings();
    const result = await e.generate(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v).toHaveLength(768);
    }
  });

  test("uses nomic-ai/nomic-embed-code model", async () => {
    const e = new NomicCodeEmbeddings();
    await e.generate(["x"]);
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      "nomic-ai/nomic-embed-code",
      expect.anything(),
    );
  });

  test("warmup() pre-loads the pipeline", async () => {
    const e = new NomicCodeEmbeddings();
    await e.warmup();
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("dispose() clears the cached pipeline", async () => {
    const e = new NomicCodeEmbeddings();
    await e.warmup();
    await e.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
