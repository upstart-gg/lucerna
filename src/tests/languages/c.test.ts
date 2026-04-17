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

describe("C", () => {
  const C_SOURCE = `#include <stdio.h>
#include <string.h>

struct Point {
    int x;
    int y;
};

int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}

void print_greeting(const char *name) {
    printf("Hello, %s!\\n", name);
}
`;

  test("detectLanguage: .c -> c", () => {
    expect(TreeSitterChunker.detectLanguage("foo.c")).toBe("c");
  });

  test("detectLanguage: .h -> c", () => {
    expect(TreeSitterChunker.detectLanguage("foo.h")).toBe("c");
  });

  test("extracts named functions", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("add");
    expect(names).toContain("multiply");
    expect(names).toContain("print_greeting");
  });

  test("extracts struct as class type with name", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("Point");
  });

  test("emits import chunk for #include directives", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("stdio.h");
  });

  test("all chunks have language: c", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    for (const c of chunks) expect(c.language).toBe("c");
  });

  test("chunk content contains function source", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("return a + b");
  });
});
