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

describe("Solidity", () => {
  const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IGreeter.sol";

contract Greeter {
    string private greeting;

    constructor(string memory _greeting) {
        greeting = _greeting;
    }

    function greet() public view returns (string memory) {
        return greeting;
    }

    function setGreeting(string memory _greeting) public {
        greeting = _greeting;
    }
}
`;

  test("detectLanguage: .sol -> solidity", () => {
    expect(TreeSitterChunker.detectLanguage("foo.sol")).toBe("solidity");
  });

  test("produces chunks for Solidity source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts functions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    // Solidity contract functions are extracted as function chunks
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
    const names = fns.map((c) => c.name).filter(Boolean);
    expect(names).toContain("greet");
  });

  test("chunk content contains function body", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("greeting");
  });

  test("all chunks have language: solidity", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    for (const c of chunks) expect(c.language).toBe("solidity");
  });
});
