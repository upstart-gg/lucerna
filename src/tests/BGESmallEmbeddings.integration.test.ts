import { afterAll, describe, expect, test } from "bun:test";
import { BGESmallEmbeddings } from "../embeddings/BGESmallEmbeddings.js";

// ---------------------------------------------------------------------------
// Integration tests — downloads the real model from HuggingFace Hub.
// Only runs when INTEGRATION_TESTS=1. No API key required.
//
// Run with: INTEGRATION_TESTS=1 bun test src/tests/BGESmallEmbeddings.integration.test.ts
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = process.env.INTEGRATION_TESTS !== "1";

describe.skipIf(SKIP_INTEGRATION)("BGESmallEmbeddings — integration", () => {
  const embeddings = new BGESmallEmbeddings();

  afterAll(async () => {
    await embeddings.dispose();
  });

  test("generate() returns 384-dim vectors", async () => {
    const result = await embeddings.generate([
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(384);
  });

  test("vectors are L2-normalized (magnitude ≈ 1.0)", async () => {
    const result = await embeddings.generate([
      "export class Tokenizer { tokenize(input: string): string[] { return input.split(' '); } }",
    ]);
    expect(result).toHaveLength(1);
    const vec = result[0] as number[];
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  test("different texts produce different vectors", async () => {
    const result = await embeddings.generate([
      "function fetchUser(id: string): Promise<User> { return db.find(id); }",
      "class Logger { log(msg: string): void { console.log(msg); } }",
    ]);
    expect(result).toHaveLength(2);
    const vecA = result[0] as number[];
    const vecB = result[1] as number[];
    const dot = vecA.reduce((sum, v, i) => sum + v * (vecB[i] ?? 0), 0);
    expect(dot).toBeLessThan(0.9999);
  });

  test("warmup() pre-loads so generate() reuses the pipeline", async () => {
    const fresh = new BGESmallEmbeddings();
    await fresh.warmup();
    const result = await fresh.generate(["const x = 42;"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(384);
    await fresh.dispose();
  });
});
