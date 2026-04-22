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

describe("Go", () => {
  const GO_SOURCE = `package main

import "fmt"

func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

func Farewell(name string) string {
	return fmt.Sprintf("Goodbye, %s!", name)
}

type UserService struct {
	db string
}

type Repository interface {
	FindAll() []string
}

func (u *UserService) FindUser(id string) string {
	return u.db
}

func (u *UserService) DeleteUser(id string) {
	_ = id
}
`;

  test("detectLanguage: .go -> go", () => {
    expect(TreeSitterChunker.detectLanguage("foo.go")).toBe("go");
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("Greet");
    expect(names).toContain("Farewell");
  });

  test("extracts receiver methods as method type", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("FindUser");
    expect(names).toContain("DeleteUser");
  });

  test("receiver method has metadata.className set to receiver type", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const findUser = chunkByName(chunks, "FindUser");
    expect(findUser).toBeDefined();
    expect(findUser?.metadata?.className).toBe("UserService");
  });

  test("struct maps to struct type with name", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const structs = chunksByType(chunks, "struct");
    const names = structs.map((c) => c.name);
    expect(names).toContain("UserService");
  });

  test("interface maps to interface type with name", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const ifaces = chunksByType(chunks, "interface");
    const names = ifaces.map((c) => c.name);
    expect(names).toContain("Repository");
  });

  test("emits import chunk for import statement", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports[0]?.content).toContain("fmt");
  });

  test("all chunks have language: go", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    for (const c of chunks) expect(c.language).toBe("go");
  });
});

describe("Go — top-level const & var", () => {
  const SRC = `package main

const DefaultEndpoint = "https://api.example.com/v2/users/and/things/here"

var GlobalConfig = map[string]string{
	"region": "us-east-1",
	"stage":  "production-canary-segment",
}

func boring() {}
`;

  test("top-level const ≥40 chars emitted as const", async () => {
    const chunks = await chunker.chunkSource(SRC, FILE("go"), PROJECT_ID, "go");
    const consts = chunksByType(chunks, "const");
    expect(consts.map((c) => c.name)).toContain("DefaultEndpoint");
  });

  test("top-level var ≥40 chars emitted as variable", async () => {
    const chunks = await chunker.chunkSource(SRC, FILE("go"), PROJECT_ID, "go");
    const vars = chunksByType(chunks, "variable");
    expect(vars.map((c) => c.name)).toContain("GlobalConfig");
  });
});
