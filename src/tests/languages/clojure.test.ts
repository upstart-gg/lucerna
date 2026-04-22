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

describe("Clojure — protocols, records, macros, multimethods", () => {
  const SRC = `(defprotocol Greetable
  (greet [this]))

(defrecord User [name email]
  Greetable
  (greet [this] (str "Hi, " name)))

(defmacro when-let [binding & body]
  \`(let [~(first binding) ~(second binding)]
     (when ~(first binding) ~@body)))

(defmulti area :shape)

(defmethod area :circle [s] 1.0)
`;

  test("defprotocol emitted as protocol chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    expect(chunksByType(chunks, "protocol").map((c) => c.name)).toContain(
      "Greetable",
    );
  });

  test("defrecord emitted as record chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    expect(chunksByType(chunks, "record").map((c) => c.name)).toContain("User");
  });

  test("defmacro emitted as macro chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    expect(chunksByType(chunks, "macro").map((c) => c.name)).toContain(
      "when-let",
    );
  });

  test("defmulti/defmethod emitted as method chunks", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("clj"),
      PROJECT_ID,
      "clojure",
    );
    const methods = chunksByType(chunks, "method").map((c) => c.name);
    expect(methods).toContain("area");
  });
});
