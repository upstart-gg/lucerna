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

describe("TypeScript", () => {
  const TS_SOURCE = `import { readFile } from "fs/promises";
import type { EventEmitter } from "events";

export interface Repository<T> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
}

export type UserId = string;

export enum Role {
  Admin = "admin",
  User = "user",
}

export class UserService implements Repository<string> {
  constructor(private readonly db: string) {}

  async findById(id: string): Promise<string | null> {
    return this.db;
  }

  async save(entity: string): Promise<void> {
    // save
  }
}

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

  test("detectLanguage: .ts -> typescript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.ts")).toBe("typescript");
  });

  test("detectLanguage: .tsx -> typescript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.tsx")).toBe("typescript");
  });

  test("extracts interface", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const ifaces = chunksByType(chunks, "interface");
    const names = ifaces.map((c) => c.name);
    expect(names).toContain("Repository");
  });

  test("extracts type alias as type chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const types = chunksByType(chunks, "type");
    const names = types.map((c) => c.name);
    expect(names).toContain("UserId");
  });

  test("type alias is extracted as a named type chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const types = chunksByType(chunks, "type");
    const names = types.map((c) => c.name);
    expect(names).toContain("UserId");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("UserService");
  });

  test("extracts class methods", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("findById");
    expect(names).toContain("save");
  });

  test("method has metadata.className set", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const method = chunkByName(chunks, "findById");
    expect(method).toBeDefined();
    expect(method?.metadata?.className).toBe("UserService");
  });

  test("extracts top-level function", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("emits import chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("fs/promises");
  });

  test("all chunks have language: typescript", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    for (const c of chunks) expect(c.language).toBe("typescript");
  });

  test("extracts enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const enums = chunksByType(chunks, "enum");
    expect(enums.map((c) => c.name)).toContain("Role");
  });
});

describe("TypeScript — namespaces, const objects, JSDoc absorption", () => {
  const SRC = `
/**
 * Greets the given name with extra warmth.
 */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export namespace Geometry {
  export function area(): number { return 0; }
}

export const ROUTES = {
  home: "/",
  about: "/about",
  contact: "/contact",
  settings: "/settings",
};
`.trim();

  test("namespace emitted as namespace chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    expect(chunksByType(chunks, "namespace").map((c) => c.name)).toContain(
      "Geometry",
    );
  });

  test("top-level const object emitted as const chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    expect(chunksByType(chunks, "const").map((c) => c.name)).toContain(
      "ROUTES",
    );
  });

  test("JSDoc above function is absorbed into the function content", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ts"),
      PROJECT_ID,
      "typescript",
    );
    const fn = chunkByName(chunks, "greet");
    expect(fn?.content).toContain("Greets the given name");
  });
});
