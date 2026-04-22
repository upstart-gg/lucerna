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

describe("R — S4 class system", () => {
  const SRC = `setClass("Person", representation(name = "character", age = "numeric"))

setGeneric("greet", function(x) standardGeneric("greet"))

setMethod("greet", "Person", function(x) {
  paste("Hello,", x@name)
})
`;

  test("setClass emitted as class chunk", async () => {
    const chunks = await chunker.chunkSource(SRC, FILE("R"), PROJECT_ID, "r");
    const names = chunksByType(chunks, "class").map((c) => c.name);
    expect(names).toContain("Person");
  });

  test("setMethod emitted as method chunk", async () => {
    const chunks = await chunker.chunkSource(SRC, FILE("R"), PROJECT_ID, "r");
    const names = chunksByType(chunks, "method").map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("setGeneric emitted as function chunk", async () => {
    const chunks = await chunker.chunkSource(SRC, FILE("R"), PROJECT_ID, "r");
    const names = chunksByType(chunks, "function").map((c) => c.name);
    expect(names).toContain("greet");
  });
});
