import { afterAll, describe, expect, test } from "bun:test";
import { NomicCodeEmbeddings } from "../embeddings/NomicCodeEmbeddings.js";

// ---------------------------------------------------------------------------
// Integration tests for the NomicCodeEmbeddings backwards-compat alias.
// Verifies the alias resolves to the working JinaCodeEmbeddings backend.
// Only runs when INTEGRATION_TESTS=1. No API key required.
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = process.env.INTEGRATION_TESTS !== "1";

describe.skipIf(SKIP_INTEGRATION)("NomicCodeEmbeddings — integration", () => {
  const embeddings = new NomicCodeEmbeddings();

  afterAll(async () => {
    await embeddings.dispose();
  });

  test("generate() returns 768-dim vectors", async () => {
    const result = await embeddings.generate([
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);
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
});
