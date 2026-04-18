import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers
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
import { NomicTextEmbeddings } from "../embeddings/NomicTextEmbeddings.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NomicTextEmbeddings", () => {
  beforeEach(() => {
    mockPipelineInstance.mockClear();
    mockPipelineFactory.mockClear();
    mockDispose.mockClear();
  });

  test("dimensions is 768", () => {
    expect(new NomicTextEmbeddings().dimensions).toBe(768);
  });

  test("generate() returns 768-dimensional vectors", async () => {
    const e = new NomicTextEmbeddings();
    const result = await e.generate(["some text"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);
  });

  test("generate() returns multiple 768-dim vectors for multiple inputs", async () => {
    const e = new NomicTextEmbeddings();
    const result = await e.generate(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v).toHaveLength(768);
    }
  });

  test("uses nomic-ai/nomic-embed-text-v1.5 model with q8 dtype", async () => {
    const e = new NomicTextEmbeddings();
    await e.generate(["x"]);
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      "nomic-ai/nomic-embed-text-v1.5",
      expect.objectContaining({ dtype: "q8" }),
    );
  });

  test("warmup() pre-loads the pipeline", async () => {
    const e = new NomicTextEmbeddings();
    await e.warmup();
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("dispose() clears the cached pipeline", async () => {
    const e = new NomicTextEmbeddings();
    await e.warmup();
    await e.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
