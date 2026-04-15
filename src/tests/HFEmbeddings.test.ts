import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers before importing the module under test.
// HFEmbeddings does a dynamic `await import(...)` inside loadPipeline(), so
// mock.module() needs to be registered before any generate/warmup call.
// ---------------------------------------------------------------------------

const mockDispose = mock(async () => {});

// The pipeline *instance* — a callable with a .dispose() method.
// We use Object.assign so bun:test can track call counts via mockPipelineInstance.
const mockPipelineInstance = Object.assign(
  mock(async (inputs: string[], _opts: unknown) => ({
    tolist: () => inputs.map((_: string) => new Array(384).fill(0.1)),
  })),
  { dispose: mockDispose },
);

// The factory function returned by `pipeline("feature-extraction", ...)`.
const mockPipelineFactory = mock(
  async (_task: string, _model: string, _opts: unknown) => mockPipelineInstance,
);

mock.module("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: { allowLocalModels: true },
}));

// Import AFTER mock.module() registration.
import { HFEmbeddings } from "../embeddings/HFEmbeddings.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HFEmbeddings", () => {
  beforeEach(() => {
    mockPipelineInstance.mockClear();
    mockPipelineFactory.mockClear();
    mockDispose.mockClear();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  test("default dimensions are 384", () => {
    const e = new HFEmbeddings();
    expect(e.dimensions).toBe(384);
  });

  test("custom constructor parameters are applied", () => {
    const e = new HFEmbeddings("custom/model", 768, "fp16", 16);
    expect(e.dimensions).toBe(768);
  });

  // -------------------------------------------------------------------------
  // generate()
  // -------------------------------------------------------------------------

  test("generate() returns one vector per input text", async () => {
    const e = new HFEmbeddings();
    const result = await e.generate(["hello"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(384);
  });

  test("generate() returns multiple vectors for multiple texts", async () => {
    const e = new HFEmbeddings();
    const result = await e.generate(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v).toHaveLength(384);
    }
  });

  test("generate() processes inputs in batches of maxBatchSize", async () => {
    // maxBatchSize = 2, so 5 texts → 3 pipeline calls
    const e = new HFEmbeddings("model", 384, "fp32", 2);
    const texts = ["a", "b", "c", "d", "e"];
    const result = await e.generate(texts);
    expect(result).toHaveLength(5);
    expect(mockPipelineInstance).toHaveBeenCalledTimes(3);
  });

  test("generate() reuses the loaded pipeline on subsequent calls", async () => {
    const e = new HFEmbeddings();
    await e.generate(["first"]);
    await e.generate(["second"]);
    // Factory should only be called once — pipeline is cached.
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("generate() throws a friendly error when pipeline creation fails", async () => {
    // Make the factory reject on the next call
    mockPipelineFactory.mockImplementationOnce(async () => {
      throw new Error("not installed");
    });

    const e = new HFEmbeddings("bad/model");
    await expect(e.generate(["x"])).rejects.toThrow(
      /Failed to load embedding model/,
    );
  });

  // -------------------------------------------------------------------------
  // warmup()
  // -------------------------------------------------------------------------

  test("warmup() pre-loads the pipeline", async () => {
    const e = new HFEmbeddings();
    await e.warmup();
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("warmup() is idempotent — does not reload if already warm", async () => {
    const e = new HFEmbeddings();
    await e.warmup();
    await e.warmup();
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  test("warmup() followed by generate() does not reload the pipeline", async () => {
    const e = new HFEmbeddings();
    await e.warmup();
    await e.generate(["test"]);
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------------

  test("dispose() calls pipeline.dispose()", async () => {
    const e = new HFEmbeddings();
    await e.warmup();
    await e.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test("dispose() is a no-op when pipeline was never loaded", async () => {
    const e = new HFEmbeddings();
    await expect(e.dispose()).resolves.toBeUndefined();
    expect(mockDispose).not.toHaveBeenCalled();
  });

  test("dispose() clears the cached pipeline so it reloads on next generate()", async () => {
    const e = new HFEmbeddings();
    await e.warmup();
    await e.dispose();
    // Factory count should still be 1 at this point
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    // After dispose, generate() must reload the pipeline
    await e.generate(["after dispose"]);
    expect(mockPipelineFactory).toHaveBeenCalledTimes(2);
  });
});
