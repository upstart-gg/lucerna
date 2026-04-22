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

  test("extracts functions inside contract as method chunks", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    const methods = chunksByType(chunks, "method");
    expect(methods.length).toBeGreaterThan(0);
    const names = methods.map((c) => c.name).filter(Boolean);
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

describe("Solidity — libraries, structs, enums, events, modifiers, errors, state vars", () => {
  const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library SafeMath {
    function add(uint a, uint b) internal pure returns (uint) {
        return a + b;
    }
}

contract Token {
    uint256 public totalSupplyValue;

    struct Holder {
        address addr;
        uint256 balance;
    }

    enum Status { Active, Frozen, Burned }

    event Transfer(address indexed from, address indexed to, uint256 value);

    error InsufficientBalance(uint256 requested, uint256 available);

    modifier onlyOwner() {
        require(msg.sender == address(0), "not owner");
        _;
    }

    function transfer(address to, uint256 amt) public onlyOwner {
        totalSupplyValue -= amt;
    }
}
`;

  test("library emitted as library chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "library").map((c) => c.name)).toContain(
      "SafeMath",
    );
  });

  test("struct emitted as struct chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "struct").map((c) => c.name)).toContain(
      "Holder",
    );
  });

  test("enum emitted as enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "enum").map((c) => c.name)).toContain("Status");
  });

  test("event emitted as event chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "event").map((c) => c.name)).toContain(
      "Transfer",
    );
  });

  test("modifier emitted as modifier chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "modifier").map((c) => c.name)).toContain(
      "onlyOwner",
    );
  });

  test("error emitted as error chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sol"),
      PROJECT_ID,
      "solidity",
    );
    expect(chunksByType(chunks, "error").map((c) => c.name)).toContain(
      "InsufficientBalance",
    );
  });
});
