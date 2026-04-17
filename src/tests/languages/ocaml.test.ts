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

describe("OCaml", () => {
  const SOURCE = `open Printf
open List

let add x y = x + y

let greet name =
  printf "Hello %s\\n" name

type point = { x: float; y: float }

module Utils = struct
  let helper () = ()
end
`;

  test("detectLanguage: .ml -> ocaml", () => {
    expect(TreeSitterChunker.detectLanguage("foo.ml")).toBe("ocaml");
  });

  test("detectLanguage: .mli -> ocaml (via alias)", () => {
    expect(TreeSitterChunker.detectLanguage("foo.mli")).toBe("ocaml");
  });

  test("produces chunks for OCaml source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts let bindings as functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("add");
    expect(names).toContain("greet");
  });

  test("extracts type definitions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("point");
  });

  test("extracts import chunk from open statements", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).toContain("open Printf");
  });

  test("all chunks have language: ocaml", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    for (const c of chunks) expect(c.language).toBe("ocaml");
  });

  test("emits IMPORTS edges", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("ml"),
      PROJECT_ID,
      "ocaml",
    );
    expect(rawEdges.some((e) => e.type === "IMPORTS")).toBe(true);
  });
});
