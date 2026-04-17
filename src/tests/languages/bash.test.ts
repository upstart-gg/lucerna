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

describe("Bash", () => {
  const SH_SOURCE = `#!/bin/bash

function greet() {
    local name=$1
    echo "Hello, $name!"
}

deploy() {
    echo "deploying..."
    greet world
}

cleanup() {
    rm -rf /tmp/build
}
`;

  test("detectLanguage: .sh -> bash", () => {
    expect(TreeSitterChunker.detectLanguage("foo.sh")).toBe("bash");
  });

  test("detectLanguage: .bash -> bash", () => {
    expect(TreeSitterChunker.detectLanguage("foo.bash")).toBe("bash");
  });

  test("extracts all functions", async () => {
    const chunks = await chunker.chunkSource(
      SH_SOURCE,
      FILE("sh"),
      PROJECT_ID,
      "bash",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    // Both 'function foo()' and 'bar()' syntax should be captured
    expect(names).toContain("greet");
    expect(names).toContain("deploy");
    expect(names).toContain("cleanup");
  });

  test("all chunks have language: bash", async () => {
    const chunks = await chunker.chunkSource(
      SH_SOURCE,
      FILE("sh"),
      PROJECT_ID,
      "bash",
    );
    for (const c of chunks) expect(c.language).toBe("bash");
  });
});
