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

describe("Julia", () => {
  const SOURCE = `using DataFrames
import CSV

module MyModule
  function greet(name)
    println("Hello, $name")
  end

  struct Point
    x::Float64
    y::Float64
  end
end

function top_level()
  greet("world")
end
`;

  test("detectLanguage: .jl -> julia", () => {
    expect(TreeSitterChunker.detectLanguage("foo.jl")).toBe("julia");
  });

  test("produces chunks for Julia source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("jl"),
      PROJECT_ID,
      "julia",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("jl"),
      PROJECT_ID,
      "julia",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("function");
  });

  test("extracts module", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("jl"),
      PROJECT_ID,
      "julia",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("MyModule");
  });

  test("all chunks have language: julia", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("jl"),
      PROJECT_ID,
      "julia",
    );
    for (const c of chunks) expect(c.language).toBe("julia");
  });

  test("extracts CALLS edges", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("jl"),
      PROJECT_ID,
      "julia",
    );
    expect(rawEdges.some((e) => e.type === "CALLS")).toBe(true);
  });
});
