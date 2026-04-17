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

describe("Lua", () => {
  const SOURCE = `local M = {}

function M.greet(name)
    return "Hello, " .. name .. "!"
end

function M.farewell(name)
    return "Goodbye, " .. name .. "!"
end

local function helper()
    return "help"
end

return M
`;

  test("detectLanguage: .lua -> lua", () => {
    expect(TreeSitterChunker.detectLanguage("foo.lua")).toBe("lua");
  });

  test("produces chunks for Lua source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("lua"),
      PROJECT_ID,
      "lua",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("lua"),
      PROJECT_ID,
      "lua",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
  });

  test("all chunks have language: lua", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("lua"),
      PROJECT_ID,
      "lua",
    );
    for (const c of chunks) expect(c.language).toBe("lua");
  });
});
