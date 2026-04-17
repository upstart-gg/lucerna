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

describe("Clojure", () => {
  const SOURCE = `(ns myapp.core
  (:require [clojure.string :as str]))

(defn greet [name]
  (str "Hello, " name "!"))

(defn farewell [name]
  (str "Goodbye, " name "!"))

(defn add [a b]
  (+ a b))
`;

  test("detectLanguage: .clj -> clojure", () => {
    expect(TreeSitterChunker.detectLanguage("foo.clj")).toBe("clojure");
  });

  test("produces chunks for Clojure source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("all chunks have language: clojure", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    for (const c of chunks) expect(c.language).toBe("clojure");
  });
});
