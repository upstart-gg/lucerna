import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers — same pattern as HFEmbeddings.test.ts
// ---------------------------------------------------------------------------

const mockDispose = mock(async () => {});

const mockPipelineInstance = Object.assign(
  mock(async (inputs: string[], _opts: unknown) => ({
    tolist: () => inputs.map((_: string) => new Array(384).fill(0.1)),
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
import { BGESmallEmbeddings } from "../embeddings/BGESmallEmbeddings.js";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("BGESmallEmbeddings", () => {
  beforeEach(() => {
    mockPipelineInstance.mockClear();
    mockPipelineFactory.mockClear();
    mockDispose.mockClear();
  });

  test("dimensions is 384", () => {
    expect(new BGESmallEmbeddings().dimensions).toBe(384);
  });

  test("uses Xenova/bge-small-en-v1.5 model with fp32 dtype", async () => {
    const e = new BGESmallEmbeddings();
    await e.generate(["x"]);
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/bge-small-en-v1.5",
      expect.objectContaining({ dtype: "fp32" }),
    );
  });

  test("warmup() pre-loads the pipeline", async () => {
    const e = new BGESmallEmbeddings();
    await e.warmup();
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("dispose() clears the cached pipeline", async () => {
    const e = new BGESmallEmbeddings();
    await e.warmup();
    await e.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
