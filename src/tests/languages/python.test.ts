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

describe("Python", () => {
  const PY_SOURCE = `import os
from pathlib import Path

def greet(name):
    return f"Hello, {name}!"

def farewell(name):
    return f"Goodbye, {name}!"

class UserService:
    def __init__(self, db):
        self.db = db

    def find_user(self, user_id):
        return self.db.find(user_id)

    def delete_user(self, user_id):
        self.db.delete(user_id)
`;

  test("detectLanguage: .py -> python", () => {
    expect(TreeSitterChunker.detectLanguage("foo.py")).toBe("python");
  });

  test("detectLanguage: .pyw -> python", () => {
    expect(TreeSitterChunker.detectLanguage("foo.pyw")).toBe("python");
  });

  test("lazy-init: no extraLanguages needed for python", async () => {
    const freshChunker = new TreeSitterChunker({});
    await freshChunker.initialize();
    const chunks = await freshChunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    expect(chunks.length).toBeGreaterThan(0);
    await freshChunker.close();
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("farewell");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const cls = chunksByType(chunks, "class");
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
  });

  test("extracts methods as children of class", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const fns = chunksByType(chunks, "function");
    const methodNames = fns.map((c) => c.name);
    expect(methodNames).toContain("find_user");
    expect(methodNames).toContain("delete_user");
  });

  test("class method contextContent contains class breadcrumb", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const findUser = chunkByName(chunks, "find_user");
    expect(findUser).toBeDefined();
    expect(findUser?.contextContent).toContain("// Class: UserService");
  });

  test("emits import chunk for import statements", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("import os");
  });

  test("all chunks have language: python", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    for (const c of chunks) expect(c.language).toBe("python");
  });

  test("all chunks contextContent starts with // File:", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    for (const c of chunks) expect(c.contextContent).toContain("// File:");
  });
});
