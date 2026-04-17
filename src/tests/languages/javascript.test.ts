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

function chunkByName(chunks: CodeChunk[], name: string): CodeChunk | undefined {
  return chunks.find((c) => c.name === name);
}

describe("JavaScript", () => {
  const JS_SOURCE = `import { readFile } from "fs/promises";
import path from "path";

class UserService {
  constructor(db) {
    this.db = db;
  }

  async findUser(id) {
    return this.db;
  }

  async deleteUser(id) {
    // delete
  }
}

function greet(name) {
  return \`Hello, \${name}!\`;
}

const farewell = (name) => \`Goodbye, \${name}!\`;
`;

  test("detectLanguage: .js -> javascript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.js")).toBe("javascript");
  });

  test("detectLanguage: .mjs -> javascript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.mjs")).toBe("javascript");
  });

  test("detectLanguage: .jsx -> javascript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.jsx")).toBe("javascript");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("UserService");
  });

  test("extracts class methods", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("findUser");
    expect(names).toContain("deleteUser");
  });

  test("method has metadata.className set", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    const method = chunkByName(chunks, "findUser");
    expect(method).toBeDefined();
    expect(method?.metadata?.className).toBe("UserService");
  });

  test("extracts named function declaration", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("emits import chunk", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("fs/promises");
  });

  test("all chunks have language: javascript", async () => {
    const chunks = await chunker.chunkSource(
      JS_SOURCE,
      FILE("js"),
      PROJECT_ID,
      "javascript",
    );
    for (const c of chunks) expect(c.language).toBe("javascript");
  });
});
