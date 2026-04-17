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

describe("R", () => {
  const SOURCE = `library(dplyr)
library(ggplot2)

greet <- function(name) {
  paste("Hello,", name, "!")
}

farewell <- function(name) {
  paste("Goodbye,", name, "!")
}

add <- function(a, b) {
  a + b
}
`;

  test("detectLanguage: .r -> r", () => {
    expect(TreeSitterChunker.detectLanguage("foo.r")).toBe("r");
  });

  test("detectLanguage: .R -> r", () => {
    expect(TreeSitterChunker.detectLanguage("foo.R")).toBe("r");
  });

  test("produces chunks for R source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("r"),
      PROJECT_ID,
      "r",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("r"),
      PROJECT_ID,
      "r",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("all chunks have language: r", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("r"),
      PROJECT_ID,
      "r",
    );
    for (const c of chunks) expect(c.language).toBe("r");
  });
});
