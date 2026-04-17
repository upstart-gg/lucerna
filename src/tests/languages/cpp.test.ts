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

describe("C++", () => {
  const CPP_SOURCE = `#include <string>
#include <vector>

class Animal {
public:
    virtual std::string speak() const = 0;
    void sleep() { }
};

class Dog : public Animal {
public:
    std::string speak() const override {
        return "Woof";
    }
};

int add(int a, int b) {
    return a + b;
}
`;

  test("detectLanguage: .cpp -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.cpp")).toBe("cpp");
  });

  test("detectLanguage: .hpp -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.hpp")).toBe("cpp");
  });

  test("detectLanguage: .cc -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.cc")).toBe("cpp");
  });

  test("extracts named class chunks", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("Animal");
    expect(names).toContain("Dog");
  });

  test("extracts free function with name", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("add");
  });

  test("emits import chunk for #include directives", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("string");
  });

  test("all chunks have language: cpp", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    for (const c of chunks) expect(c.language).toBe("cpp");
  });
});

describe("Graph edges — C++ EXTENDS", () => {
  const SOURCE = `class Animal {
public:
    virtual void speak() = 0;
};

class Dog : public Animal {
public:
    void speak() override {}
};
`;

  test("emits EXTENDS edge for class : Base", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    expect(ext.length).toBeGreaterThan(0);
    expect(ext[0]?.targetSymbol).toBe("Animal");
  });
});
