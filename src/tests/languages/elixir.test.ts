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

describe("Elixir", () => {
  const SOURCE = `defmodule MyApp.Greetings do
  @moduledoc """
  Greeting functions.
  """

  def greet(name) do
    "Hello, #{name}!"
  end

  def farewell(name) do
    "Goodbye, #{name}!"
  end

  defp helper(x) do
    x * 2
  end
end
`;

  test("detectLanguage: .ex -> elixir", () => {
    expect(TreeSitterChunker.detectLanguage("foo.ex")).toBe("elixir");
  });

  test("detectLanguage: .exs -> elixir", () => {
    expect(TreeSitterChunker.detectLanguage("foo.exs")).toBe("elixir");
  });

  test("produces chunks for Elixir source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts module as module chunk", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    const mods = chunksByType(chunks, "module");
    const names = mods.map((c) => c.name).filter(Boolean);
    expect(names).toContain("MyApp.Greetings");
  });

  test("extracts functions as method chunks inside module", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    // Elixir def functions are extracted as method chunks under the module
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name).filter(Boolean);
    expect(names).toContain("greet");
  });

  test("all chunks have language: elixir", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    for (const c of chunks) expect(c.language).toBe("elixir");
  });
});

describe("Elixir — protocols, impls, macros", () => {
  const SRC = `defprotocol Stringify do
  def to_str(value)
end

defimpl Stringify, for: Integer do
  def to_str(value), do: Integer.to_string(value)
end

defmodule MyMacros do
  defmacro unless(condition, do: block) do
    quote do
      if !unquote(condition), do: unquote(block)
    end
  end
end
`;

  test("defprotocol emitted as protocol chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    expect(chunksByType(chunks, "protocol").map((c) => c.name)).toContain(
      "Stringify",
    );
  });

  test("defimpl emitted as instance chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    expect(chunksByType(chunks, "instance").length).toBeGreaterThan(0);
  });

  test("defmacro emitted as macro chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ex"),
      PROJECT_ID,
      "elixir",
    );
    expect(chunksByType(chunks, "macro").map((c) => c.name)).toContain(
      "unless",
    );
  });
});
