import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";
import type { ChunkType, CodeChunk } from "../../types.js";

const PROJECT_ID = "test-lang";
const FILE = (ext: string) => `test/src/sample.${ext}`;

let chunker: TreeSitterChunker;

beforeAll(async () => {
  chunker = new TreeSitterChunker({});
  await chunker.initialize();
});

afterAll(async () => {
  await chunker.close();
});

function chunksByType(chunks: CodeChunk[], type: ChunkType): CodeChunk[] {
  return chunks.filter((c) => c.type === type);
}

describe("MATLAB", () => {
  const SOURCE = `function result = greet(name)
    result = ['Hello, ' name '!'];
end

function result = add(a, b)
    result = a + b;
end
`;

  test("detectLanguage: .matlab -> matlab", () => {
    expect(TreeSitterChunker.detectLanguage("foo.matlab")).toBe("matlab");
  });

  test("produces chunks for MATLAB source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("matlab"),
      PROJECT_ID,
      "matlab",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("matlab"),
      PROJECT_ID,
      "matlab",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("all chunks have language: matlab", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("matlab"),
      PROJECT_ID,
      "matlab",
    );
    for (const c of chunks) expect(c.language).toBe("matlab");
  });
});
