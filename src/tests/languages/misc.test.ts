import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";

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

// ---------------------------------------------------------------------------
// Graph edge tests — DEFINES (all languages)
// ---------------------------------------------------------------------------

describe("Graph edges — DEFINES (all languages)", () => {
  const PY_SOURCE = `import os

def greet(name):
    return f"Hello, {name}!"
`;

  test("emits DEFINES edges from import chunk to named chunks (Python)", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const defines = rawEdges.filter((e) => e.type === "DEFINES");
    expect(defines.length).toBeGreaterThan(0);
  });

  const RB_SOURCE = `require 'json'

def greet(name)
  "Hello, #{name}!"
end
`;

  test("emits DEFINES edges from import chunk to named chunks (Ruby)", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const defines = rawEdges.filter((e) => e.type === "DEFINES");
    expect(defines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unsupported language
// ---------------------------------------------------------------------------

describe("unsupported language", () => {
  test("returns empty chunks for a language the pack does not know", async () => {
    const chunks = await chunker.chunkSource(
      "some content",
      "test.xyz",
      PROJECT_ID,
      "xyzlanguagethatdoesnotexist",
    );
    expect(chunks).toEqual([]);
  });
});
