import { afterAll, describe, expect, test } from "bun:test";
import { LocalReranker } from "../embeddings/LocalReranker.js";

// ---------------------------------------------------------------------------
// Integration tests — downloads the real model from HuggingFace Hub.
// Only runs when INTEGRATION_TESTS=1. No API key required.
//
// Run with: INTEGRATION_TESTS=1 bun test src/tests/LocalReranker.integration.test.ts
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = process.env.INTEGRATION_TESTS !== "1";

describe.skipIf(SKIP_INTEGRATION)("LocalReranker — integration", () => {
  const reranker = new LocalReranker();

  afterAll(async () => {
    await reranker.dispose();
  });

  test("rerank() returns one score per input text", async () => {
    const scores = await reranker.rerank("authentication function", [
      "function authenticate(user: string, pass: string): boolean {}",
      "const PI = 3.14159;",
    ]);
    expect(scores).toHaveLength(2);
  });

  test("scores are in [0, 1]", async () => {
    const scores = await reranker.rerank("sort array", [
      "function bubbleSort(arr: number[]): number[] { return arr.sort(); }",
      "const host = 'localhost';",
    ]);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("more relevant text scores higher", async () => {
    const scores = await reranker.rerank("recursive fibonacci function", [
      "const DB_URL = 'postgres://localhost/mydb';",
      "function fibonacci(n: number): number { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }",
    ]);
    expect(scores).toHaveLength(2);
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
  });

  test("warmup() pre-loads so rerank() reuses the model", async () => {
    const fresh = new LocalReranker();
    await fresh.warmup();
    const scores = await fresh.rerank("hash map lookup", [
      "function get(key: string) { return this.map.get(key); }",
    ]);
    expect(scores).toHaveLength(1);
    await fresh.dispose();
  });
});
