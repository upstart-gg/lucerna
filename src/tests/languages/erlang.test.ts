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

describe("Erlang", () => {
  const SOURCE = `-module(hello).
-export([greet/1, add/2]).

greet(Name) ->
    io:format("Hello ~s~n", [Name]).

add(X, Y) -> X + Y.
`;

  test("detectLanguage: .erl -> erlang", () => {
    expect(TreeSitterChunker.detectLanguage("foo.erl")).toBe("erlang");
  });

  test("produces chunks for Erlang source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("erl"),
      PROJECT_ID,
      "erlang",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("erl"),
      PROJECT_ID,
      "erlang",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("add");
  });

  test("extracts import chunk from module attribute", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("erl"),
      PROJECT_ID,
      "erlang",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).toContain("-module(hello)");
  });

  test("all chunks have language: erlang", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("erl"),
      PROJECT_ID,
      "erlang",
    );
    for (const c of chunks) expect(c.language).toBe("erlang");
  });

  test("extracts CALLS edges", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("erl"),
      PROJECT_ID,
      "erlang",
    );
    expect(rawEdges.some((e) => e.type === "CALLS")).toBe(true);
  });
});
