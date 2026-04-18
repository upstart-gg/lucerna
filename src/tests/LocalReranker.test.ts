import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers
// ---------------------------------------------------------------------------

const mockModelDispose = mock(async () => {});

// Model returns raw logits; sigmoid is applied by HFReranker
const mockModelRun = mock(
  async (_inputs: unknown): Promise<{ logits: { data: Float32Array } }> => ({
    logits: { data: new Float32Array([2.0, -1.0]) },
  }),
);
const mockModelInstance = Object.assign(mockModelRun, {
  dispose: mockModelDispose,
});
const mockModelFactory = mock(async () => mockModelInstance);

const mockTokenizerInstance = mock(
  (_queries: string[], _opts: unknown): Record<string, unknown> => ({}),
);
const mockTokenizerFactory = mock(async () => mockTokenizerInstance);

mock.module("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: mockTokenizerFactory },
  AutoModelForSequenceClassification: { from_pretrained: mockModelFactory },
  env: { allowLocalModels: true, allowRemoteModels: true },
}));

// Import AFTER mock.module() registration.
import { LocalReranker } from "../embeddings/LocalReranker.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalReranker", () => {
  beforeEach(() => {
    mockModelRun.mockClear();
    mockModelFactory.mockClear();
    mockModelDispose.mockClear();
    mockTokenizerInstance.mockClear();
    mockTokenizerFactory.mockClear();
  });

  test("rerank() returns one score per input text", async () => {
    const r = new LocalReranker();
    const scores = await r.rerank("query", ["text one", "text two"]);
    expect(scores).toHaveLength(2);
  });

  test("scores are in [0, 1] (sigmoid applied to logits)", async () => {
    const r = new LocalReranker();
    const scores = await r.rerank("query", ["a", "b"]);
    // logit 2.0 → sigmoid ≈ 0.88; logit -1.0 → sigmoid ≈ 0.27
    for (const s of scores) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 1);
  });

  test("empty input returns [] without loading the model", async () => {
    const r = new LocalReranker();
    const scores = await r.rerank("query", []);
    expect(scores).toHaveLength(0);
    expect(mockModelFactory).not.toHaveBeenCalled();
    expect(mockTokenizerFactory).not.toHaveBeenCalled();
  });

  test("uses jinaai/jina-reranker-v1-turbo-en with dtype q8", async () => {
    const r = new LocalReranker();
    await r.rerank("q", ["text"]);
    expect(mockModelFactory).toHaveBeenCalledWith(
      "jinaai/jina-reranker-v1-turbo-en",
      expect.objectContaining({ dtype: "q8" }),
    );
    expect(mockTokenizerFactory).toHaveBeenCalledWith(
      "jinaai/jina-reranker-v1-turbo-en",
    );
  });

  test("tokenizer called with text_pair and correct max_length", async () => {
    const r = new LocalReranker();
    await r.rerank("my query", ["passage one", "passage two"]);
    expect(mockTokenizerInstance).toHaveBeenCalledWith(
      ["my query", "my query"],
      expect.objectContaining({
        text_pair: ["passage one", "passage two"],
        truncation: true,
        max_length: 8192,
      }),
    );
  });

  test("warmup() pre-loads the model", async () => {
    const r = new LocalReranker();
    await r.warmup();
    expect(mockModelFactory).toHaveBeenCalledTimes(1);
    expect(mockTokenizerFactory).toHaveBeenCalledTimes(1);
  });

  test("model is not reloaded on subsequent rerank() calls", async () => {
    const r = new LocalReranker();
    await r.rerank("q", ["a"]);
    await r.rerank("q", ["b"]);
    expect(mockModelFactory).toHaveBeenCalledTimes(1);
  });

  test("dispose() clears the cached model", async () => {
    const r = new LocalReranker();
    await r.warmup();
    await r.dispose();
    expect(mockModelDispose).toHaveBeenCalledTimes(1);
  });
});
