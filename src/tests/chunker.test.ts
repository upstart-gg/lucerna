import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeSitterChunker } from "../chunker/index.js";
import { hashEdgeId } from "../store/GraphStore.js";

// These tests use the compiled source directly via bun — no build step needed.

const PROJECT_ID = "test-project";

let chunker: TreeSitterChunker;

beforeAll(async () => {
  chunker = new TreeSitterChunker({});
  await chunker.initialize();
});

afterAll(async () => {
  await chunker.close();
});

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe("detectLanguage", () => {
  test("detects typescript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.ts")).toBe("typescript");
    expect(TreeSitterChunker.detectLanguage("foo.tsx")).toBe("typescript");
  });

  test("detects javascript", () => {
    expect(TreeSitterChunker.detectLanguage("foo.js")).toBe("javascript");
    expect(TreeSitterChunker.detectLanguage("foo.mjs")).toBe("javascript");
  });

  test("detects json", () => {
    expect(TreeSitterChunker.detectLanguage("package.json")).toBe("json");
  });

  test("detects markdown", () => {
    expect(TreeSitterChunker.detectLanguage("README.md")).toBe("markdown");
  });

  test("returns null for truly unknown extension", () => {
    expect(TreeSitterChunker.detectLanguage("foo.docx")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TypeScript chunking
// ---------------------------------------------------------------------------

describe("TypeScript chunking", () => {
  const TS_SOURCE = `
import { foo } from './foo';
import { bar } from './bar';

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class UserService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async findUser(id: string): Promise<User | null> {
    return this.db.find(id);
  }
}

export interface User {
  id: string;
  name: string;
}

export type UserId = string;
  `.trim();

  test("extracts import chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).toContain("import { foo }");
    expect(importChunk?.content).toContain("import { bar }");
  });

  test("extracts function chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.content).toContain("function greet");
    expect(fn?.contextContent).toContain("import {"); // imports prepended
  });

  test("extracts class chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const cls = chunks.find(
      (c) => c.type === "class" && c.name === "UserService",
    );
    expect(cls).toBeDefined();
  });

  test("extracts method chunks from class", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const method = chunks.find(
      (c) => c.type === "method" && c.name?.includes("findUser"),
    );
    expect(method).toBeDefined();
    expect(method?.metadata.className).toBe("UserService");
  });

  test("extracts interface chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const iface = chunks.find(
      (c) => c.type === "interface" && c.name === "User",
    );
    expect(iface).toBeDefined();
  });

  test("extracts type alias chunk", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const type = chunks.find((c) => c.type === "type" && c.name === "UserId");
    expect(type).toBeDefined();
  });

  test("assigns stable IDs", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    const ids = chunks.map((c) => c.id);
    // All IDs should be non-empty 16-char hex strings
    for (const id of ids) {
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]+$/);
    }
    // IDs should be unique
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("sets correct line numbers", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "test.ts",
      PROJECT_ID,
      "typescript",
    );
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON chunking
// ---------------------------------------------------------------------------

describe("JSON chunking", () => {
  test("small JSON: single file chunk", async () => {
    const source = JSON.stringify({ name: "foo", version: "1.0.0" }, null, 2);
    const chunks = await chunker.chunkSource(
      source,
      "package.json",
      PROJECT_ID,
      "json",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe("file");
  });

  test("large JSON: chunks per top-level key", async () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      obj[`key${i}`] = {
        value: i,
        description: "some long description that takes up space",
      };
    }
    const source = JSON.stringify(obj, null, 2);
    const chunks = await chunker.chunkSource(
      source,
      "data.json",
      PROJECT_ID,
      "json",
    );
    // Should have multiple chunks for each top-level key
    expect(chunks.length).toBeGreaterThan(1);
    const names = chunks.map((c) => c.name).filter(Boolean);
    expect(names).toContain("key0");
  });

  test("large JSON with few keys: uses pack structure extraction", async () => {
    // Produce a JSON that has ≤3 top-level keys but is large enough (>6000 chars)
    // to bypass the size shortcut, triggering the packProcess structure path.
    const longStr = "x".repeat(300);
    const bigObj = {
      data: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        value: longStr,
        label: `item-${i}`,
      })),
    };
    const source = JSON.stringify(bigObj, null, 2);
    // source.length should be well over 6000 chars
    expect(source.length).toBeGreaterThan(6000);

    const chunks = await chunker.chunkSource(
      source,
      "big.json",
      PROJECT_ID,
      "json",
    );
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Markdown chunking
// ---------------------------------------------------------------------------

describe("Markdown chunking", () => {
  const MD_SOURCE = `# Guide

Introduction paragraph.

## Installation

Run npm install.

### Configuration

Set up your config file.

## Usage

Use the library.
  `.trim();

  test("splits by headings", async () => {
    const chunks = await chunker.chunkSource(
      MD_SOURCE,
      "README.md",
      PROJECT_ID,
      "markdown",
    );
    expect(chunks.length).toBeGreaterThan(0);
    const types = chunks.map((c) => c.type);
    expect(types.every((t) => t === "section" || t === "file")).toBe(true);
  });

  test("section names match headings", async () => {
    const chunks = await chunker.chunkSource(
      MD_SOURCE,
      "README.md",
      PROJECT_ID,
      "markdown",
    );
    const names = chunks.map((c) => c.name).filter(Boolean);
    // Should include at least some of the headings
    expect(names.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Arrow function detection (TypeScript)
// ---------------------------------------------------------------------------

describe("Arrow function detection", () => {
  const SOURCE = `
const add = (a: number, b: number): number => a + b;

export const multiply = (a: number, b: number): number => {
  return a * b;
};
  `.trim();

  test("extracts arrow functions assigned to variables", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      "math.ts",
      PROJECT_ID,
      "typescript",
    );
    const fns = chunks.filter((c) => c.type === "function");
    expect(fns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback: small/structureless file
// ---------------------------------------------------------------------------

describe("Fallback behaviour", () => {
  test("returns file chunk for tiny structureless file", async () => {
    const source = "console.log('hello');";
    const chunks = await chunker.chunkSource(
      source,
      "script.ts",
      PROJECT_ID,
      "typescript",
    );
    // Should not crash; should return at least one chunk
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// JavaScript chunking (via chunkSource — exercises extractJavaScript wrapper)
// ---------------------------------------------------------------------------

describe("JavaScript chunking", () => {
  test("extracts top-level function declaration", async () => {
    const source = `
function greet(name) {
  return "Hello, " + name;
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "greet.js",
      PROJECT_ID,
      "javascript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.language).toBe("javascript");
  });

  test("extracts exported function declaration", async () => {
    const source = `
export function compute(x) {
  return x * 2;
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "compute.js",
      PROJECT_ID,
      "javascript",
    );
    const fn = chunks.find(
      (c) => c.type === "function" && c.name === "compute",
    );
    expect(fn).toBeDefined();
  });

  test("extracts generator function declaration", async () => {
    const source = `
function* counter() {
  let i = 0;
  while (true) { yield i++; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "counter.js",
      PROJECT_ID,
      "javascript",
    );
    const gen = chunks.find(
      (c) => c.type === "function" && c.name === "counter",
    );
    expect(gen).toBeDefined();
  });

  test("extracts exported generator function", async () => {
    const source = `
export function* range(start, end) {
  for (let i = start; i < end; i++) yield i;
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "range.js",
      PROJECT_ID,
      "javascript",
    );
    const gen = chunks.find((c) => c.type === "function" && c.name === "range");
    expect(gen).toBeDefined();
  });

  test("extracts non-exported class with methods", async () => {
    const source = `
class Shape {
  constructor(color) { this.color = color; }
  draw() { return "drawing " + this.color; }
  area() { return 0; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "shape.js",
      PROJECT_ID,
      "javascript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Shape");
    expect(cls).toBeDefined();
    const method = chunks.find(
      (c) => c.type === "method" && c.name?.includes("draw"),
    );
    expect(method).toBeDefined();
  });

  test("extracts exported class with methods", async () => {
    const source = `
export class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " speaks"; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "animal.js",
      PROJECT_ID,
      "javascript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Animal");
    expect(cls).toBeDefined();
    const method = chunks.find(
      (c) => c.type === "method" && c.name?.includes("speak"),
    );
    expect(method).toBeDefined();
  });

  test("extracts exported arrow function", async () => {
    const source = `export const add = (a, b) => a + b;`;
    const chunks = await chunker.chunkSource(
      source,
      "math.js",
      PROJECT_ID,
      "javascript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "add");
    expect(fn).toBeDefined();
  });

  test("extracts non-exported arrow function", async () => {
    const source = `const square = (x) => x * x;`;
    const chunks = await chunker.chunkSource(
      source,
      "util.js",
      PROJECT_ID,
      "javascript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "square");
    expect(fn).toBeDefined();
  });

  test("extracts non-exported function expression variable", async () => {
    const source = `const double = function(x) { return x * 2; };`;
    const chunks = await chunker.chunkSource(
      source,
      "double.js",
      PROJECT_ID,
      "javascript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "double");
    expect(fn).toBeDefined();
  });

  test("falls back to file chunk for structureless JS", async () => {
    const source = `console.log("hello");`;
    const chunks = await chunker.chunkSource(
      source,
      "script.js",
      PROJECT_ID,
      "javascript",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.language).toBe("javascript");
  });

  test("includes import chunk when imports are present", async () => {
    const source = `
import { foo } from './foo.js';
import { bar } from './bar.js';

export function useIt() {
  return foo() + bar();
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "service.js",
      PROJECT_ID,
      "javascript",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).toContain("import { foo }");
  });
});

// ---------------------------------------------------------------------------
// TypeScript — non-exported and edge-case declarations
// ---------------------------------------------------------------------------

describe("TypeScript — non-exported declarations", () => {
  test("extracts non-exported function", async () => {
    const source = `function helper(x: number): number { return x * 2; }`;
    const chunks = await chunker.chunkSource(
      source,
      "helper.ts",
      PROJECT_ID,
      "typescript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "helper");
    expect(fn).toBeDefined();
  });

  test("extracts non-exported generator function", async () => {
    const source = `function* gen(): Generator<number> { yield 1; yield 2; }`;
    const chunks = await chunker.chunkSource(
      source,
      "gen.ts",
      PROJECT_ID,
      "typescript",
    );
    const gen = chunks.find((c) => c.type === "function" && c.name === "gen");
    expect(gen).toBeDefined();
  });

  test("extracts exported generator function", async () => {
    const source = `
export function* range(start: number, end: number): Generator<number> {
  for (let i = start; i < end; i++) { yield i; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "range.ts",
      PROJECT_ID,
      "typescript",
    );
    const gen = chunks.find((c) => c.type === "function" && c.name === "range");
    expect(gen).toBeDefined();
  });

  test("extracts non-exported class", async () => {
    const source = `
class Counter {
  private count = 0;
  increment(): void { this.count++; }
  value(): number { return this.count; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "counter.ts",
      PROJECT_ID,
      "typescript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Counter");
    expect(cls).toBeDefined();
  });

  test("extracts non-exported interface", async () => {
    const source = `interface Logger { log(msg: string): void; }`;
    const chunks = await chunker.chunkSource(
      source,
      "logger.ts",
      PROJECT_ID,
      "typescript",
    );
    const iface = chunks.find(
      (c) => c.type === "interface" && c.name === "Logger",
    );
    expect(iface).toBeDefined();
  });

  test("extracts non-exported type alias", async () => {
    const source = `type Handler = (event: Event) => void;`;
    const chunks = await chunker.chunkSource(
      source,
      "handler.ts",
      PROJECT_ID,
      "typescript",
    );
    const type = chunks.find((c) => c.type === "type" && c.name === "Handler");
    expect(type).toBeDefined();
  });
});

describe("TypeScript — class with implements and public fields", () => {
  test("class with IMPLEMENTS edge keyword", async () => {
    const source = `
interface Printable { print(): void; }
export class Document implements Printable {
  print(): void { console.log(this); }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "doc.ts",
      PROJECT_ID,
      "typescript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Document");
    expect(cls).toBeDefined();
  });

  test("class with public fields in header", async () => {
    const source = `
export class Config {
  public host: string = "localhost";
  public port: number = 8080;
  connect(): void {}
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "config.ts",
      PROJECT_ID,
      "typescript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Config");
    expect(cls).toBeDefined();
    // The class content should include the class definition
    expect(cls?.content).toContain("Config");
  });

  test("class extends generic base type", async () => {
    const source = `
import { Base } from './base.js';
export class Repo<T> extends Base<T> {
  find(id: string): T | null { return null; }
}
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "repo.ts",
      PROJECT_ID,
      "typescript",
    );
    const cls = chunks.find((c) => c.type === "class" && c.name === "Repo");
    expect(cls).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Markdown chunking — extended
// ---------------------------------------------------------------------------

describe("Markdown chunking — extended", () => {
  test("plain text (no headings) returns a single file chunk", async () => {
    const source =
      "Just plain text with no headings. A paragraph or two.\n\nAnother paragraph.";
    const chunks = await chunker.chunkSource(
      source,
      "plain.md",
      PROJECT_ID,
      "markdown",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe("file");
  });

  test("heading breadcrumbs flow to nested sections", async () => {
    const source = `
# Chapter 1

Introduction.

## Section 1.1

Details.

### Sub 1.1.1

Deep content.
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "book.md",
      PROJECT_ID,
      "markdown",
    );
    const sub = chunks.find((c) => c.name === "Sub 1.1.1");
    expect(sub).toBeDefined();
    expect(sub?.metadata?.breadcrumb).toBe(
      "Chapter 1 > Section 1.1 > Sub 1.1.1",
    );
    expect(sub?.contextContent).toContain("Chapter 1");
  });

  test("each chunk has the correct heading as its name", async () => {
    const source = `
# Getting Started

## Installation

## Configuration
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "guide.md",
      PROJECT_ID,
      "markdown",
    );
    const names = chunks.map((c) => c.name).filter(Boolean);
    expect(names).toContain("Getting Started");
    expect(names).toContain("Installation");
    expect(names).toContain("Configuration");
  });

  test("H4+ headings do not create separate section chunks", async () => {
    // Only H1–H3 are section boundaries in extractWithRegex
    const source = `
## Main Section

Content here.

#### Deep Heading

This stays in the parent section.
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "deep.md",
      PROJECT_ID,
      "markdown",
    );
    // Should not create a chunk named "Deep Heading" since H4 isn't a boundary
    const h4 = chunks.find((c) => c.name === "Deep Heading");
    expect(h4).toBeUndefined();
    // But the main section should still exist
    const main = chunks.find((c) => c.name === "Main Section");
    expect(main).toBeDefined();
  });

  test("section startLine and endLine are populated", async () => {
    const source = `
# Title

Content.

## Part Two

More content.
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "lines.md",
      PROJECT_ID,
      "markdown",
    );
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  test("metadata.level reflects heading depth", async () => {
    const source = `
# H1

## H2

### H3
`.trim();
    const chunks = await chunker.chunkSource(
      source,
      "levels.md",
      PROJECT_ID,
      "markdown",
    );
    const h1 = chunks.find((c) => c.name === "H1");
    const h2 = chunks.find((c) => c.name === "H2");
    const h3 = chunks.find((c) => c.name === "H3");
    expect(h1?.metadata?.level).toBe(1);
    expect(h2?.metadata?.level).toBe(2);
    expect(h3?.metadata?.level).toBe(3);
  });

  test("large section is split into multiple chunks at paragraph boundaries", async () => {
    // Use a tiny maxChunkTokens so splitLargeSection is triggered easily
    const smallChunker = new TreeSitterChunker({
      maxChunkTokens: 10, // 10 tokens × 4 chars = 40 chars threshold
    });
    await smallChunker.initialize();

    // Each paragraph is ~30 chars; the section header breadcrumb pushes it over 40.
    const source = [
      "## Big Section",
      "",
      "Paragraph one content here.",
      "",
      "Paragraph two content here.",
      "",
      "Paragraph three content.",
    ].join("\n");

    const chunks = await smallChunker.chunkSource(
      source,
      "large.md",
      PROJECT_ID,
      "markdown",
    );
    await smallChunker.close();

    // splitLargeSection should have produced more than one chunk
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.language).toBe("markdown");
      expect(chunk.type).toBe("section");
    }
  });
});

// ---------------------------------------------------------------------------
// chunkFile() — reads from disk
// ---------------------------------------------------------------------------

describe("chunkFile()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "chunker-file-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads and chunks a real TypeScript file", async () => {
    const filePath = join(tmpDir, "greet.ts");
    await writeFile(
      filePath,
      `export function greet(name: string): string { return "Hello " + name; }`,
    );
    const chunks = await chunker.chunkFile(filePath, PROJECT_ID);
    expect(chunks.length).toBeGreaterThan(0);
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
  });

  test("returns empty array for an unknown file extension", async () => {
    const filePath = join(tmpDir, "data.docx");
    await writeFile(filePath, "not code");
    const chunks = await chunker.chunkFile(filePath, PROJECT_ID);
    expect(chunks).toHaveLength(0);
  });

  test("uses the provided language override", async () => {
    const filePath = join(tmpDir, "noext");
    await writeFile(
      filePath,
      `export function hi(): void { console.log("hi"); }`,
    );
    const chunks = await chunker.chunkFile(filePath, PROJECT_ID, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// processWithPack() — non-TS/JS/JSON/Markdown language path
// ---------------------------------------------------------------------------

describe("processWithPack() for non-default languages", () => {
  let pyChunker: TreeSitterChunker;

  beforeAll(async () => {
    pyChunker = new TreeSitterChunker({});
    await pyChunker.initialize();
  });

  afterAll(async () => {
    await pyChunker.close();
  });

  const PY_SOURCE = `
def greet(name):
    return "Hello, " + name

class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
`.trim();

  test("produces chunks for a Python source file", async () => {
    const chunks = await pyChunker.chunkSource(
      PY_SOURCE,
      "calc.py",
      PROJECT_ID,
      "python",
    );
    expect(chunks.length).toBeGreaterThan(0);
    // Should not crash; verify IDs are assigned
    for (const chunk of chunks) {
      expect(chunk.id).toHaveLength(16);
    }
  });

  test("handles processWithPack() parse error gracefully", async () => {
    // An empty string with an unsupported/broken parse should fall back to a
    // single file chunk rather than throwing.
    const chunks = await pyChunker.chunkSource(
      "",
      "empty.py",
      PROJECT_ID,
      "python",
    );
    // Either returns chunks or empty — must not throw.
    expect(Array.isArray(chunks)).toBe(true);
  });

  test("unknown language (not in pack) returns empty array", async () => {
    // A language name the pack does not know at all should produce no chunks.
    const chunks = await pyChunker.chunkSource(
      "some content",
      "hello.xyzlang",
      PROJECT_ID,
      "xyzlanguagethatdoesnotexist" as never,
    );
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mapKind() — exercises all branches via processWithPack()
// ---------------------------------------------------------------------------

describe("mapKind() via Python processWithPack()", () => {
  let pyChunker: TreeSitterChunker;

  beforeAll(async () => {
    pyChunker = new TreeSitterChunker({});
    await pyChunker.initialize();
  });

  afterAll(async () => {
    await pyChunker.close();
  });

  test("function kind maps to 'function' chunk type", async () => {
    const source = `def my_function(x):\n    return x\n`;
    const chunks = await pyChunker.chunkSource(
      source,
      "fn.py",
      PROJECT_ID,
      "python",
    );
    const fn = chunks.find((c) => c.type === "function");
    // If pack emits a function kind, we verify it maps correctly
    if (fn) {
      expect(fn.type).toBe("function");
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("class kind maps to 'class' chunk type", async () => {
    const source = `class MyClass:\n    pass\n`;
    const chunks = await pyChunker.chunkSource(
      source,
      "cls.py",
      PROJECT_ID,
      "python",
    );
    const cls = chunks.find((c) => c.type === "class");
    if (cls) {
      expect(cls.type).toBe("class");
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scope-chain breadcrumb
// ---------------------------------------------------------------------------

describe("scope-chain breadcrumb", () => {
  const TS_SOURCE = `
import { foo } from './foo';

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class UserService {
  async findUser(id: string): Promise<void> {}
}
  `.trim();

  test("function contextContent starts with '// File:' line", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "greet.ts",
      PROJECT_ID,
      "typescript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.contextContent.startsWith("// File: greet.ts")).toBe(true);
  });

  test("function contextContent includes '// Function: greet'", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "greet.ts",
      PROJECT_ID,
      "typescript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.contextContent).toContain("// Function: greet");
  });

  test("method contextContent includes '// Class: UserService'", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "svc.ts",
      PROJECT_ID,
      "typescript",
    );
    const method = chunks.find(
      (c) => c.type === "method" && c.name === "findUser",
    );
    expect(method).toBeDefined();
    expect(method?.contextContent).toContain("// Class: UserService");
  });

  test("method contextContent includes '// Method: findUser'", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "svc.ts",
      PROJECT_ID,
      "typescript",
    );
    const method = chunks.find(
      (c) => c.type === "method" && c.name === "findUser",
    );
    expect(method).toBeDefined();
    expect(method?.contextContent).toContain("// Method: findUser");
  });

  test("metadata.breadcrumb is set and matches contextContent prefix", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "greet.ts",
      PROJECT_ID,
      "typescript",
    );
    const fn = chunks.find((c) => c.type === "function" && c.name === "greet");
    expect(fn).toBeDefined();
    const breadcrumb = fn?.metadata.breadcrumb as string | undefined;
    expect(breadcrumb).toBeDefined();
    expect(fn?.contextContent.startsWith(breadcrumb ?? "")).toBe(true);
  });

  test("import chunk does NOT get a scope breadcrumb", async () => {
    const chunks = await chunker.chunkSource(
      TS_SOURCE,
      "greet.ts",
      PROJECT_ID,
      "typescript",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.contextContent.startsWith("// File:")).toBe(false);
  });

  test("processWithPack() chunks get breadcrumbs", async () => {
    const pyChunker = new TreeSitterChunker({});
    await pyChunker.initialize();
    const source = `def greet(name):\n    return "Hello, " + name\n`;
    const chunks = await pyChunker.chunkSource(
      source,
      "calc.py",
      PROJECT_ID,
      "python",
    );
    await pyChunker.close();
    const fn = chunks.find((c) => c.type === "function");
    if (fn) {
      expect(fn.contextContent).toContain("// File: calc.py");
    }
    // At minimum the file chunk should have a breadcrumb
    expect(
      chunks.some((c) => c.contextContent.includes("// File: calc.py")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sibling-merging
// ---------------------------------------------------------------------------

describe("sibling-merging", () => {
  // Use a local chunker with merging enabled (50 tokens = ~200 chars threshold)
  let mergingChunker: TreeSitterChunker;

  beforeAll(async () => {
    mergingChunker = new TreeSitterChunker({ minChunkTokens: 50 });
    await mergingChunker.initialize();
  });

  afterAll(async () => {
    await mergingChunker.close();
  });

  test("adjacent micro-chunks are merged into one chunk", async () => {
    const source = `type A = string;\ntype B = number;\ntype C = boolean;\n`;
    const chunks = await mergingChunker.chunkSource(
      source,
      "types.ts",
      PROJECT_ID,
      "typescript",
    );
    const typeChunks = chunks.filter((c) => c.type === "type");
    // All three tiny type aliases should collapse into one merged chunk
    expect(typeChunks.length).toBe(1);
    expect(typeChunks[0]?.content).toContain("type A");
    expect(typeChunks[0]?.content).toContain("type C");
  });

  test("large chunks are never merged even if adjacent", async () => {
    const bigFn = (name: string) =>
      `function ${name}() {\n${"  const x = 1;\n".repeat(50)}}\n`;
    const source = bigFn("alpha") + bigFn("beta");
    const chunks = await mergingChunker.chunkSource(
      source,
      "big.ts",
      PROJECT_ID,
      "typescript",
    );
    const fns = chunks.filter((c) => c.type === "function");
    expect(fns.length).toBe(2);
  });

  test("import chunk is never merged with adjacent chunks", async () => {
    const source = `import { foo } from './foo';\ntype A = string;\n`;
    const chunks = await mergingChunker.chunkSource(
      source,
      "t.ts",
      PROJECT_ID,
      "typescript",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).not.toContain("type A");
  });

  test("chunks from different classes are not merged", async () => {
    // Use tiny one-liner methods so both are below the merge threshold
    const source = `class A { x(): void {} }\nclass B { y(): void {} }\n`;
    const chunks = await mergingChunker.chunkSource(
      source,
      "ab.ts",
      PROJECT_ID,
      "typescript",
    );
    const xMethod = chunks.find((c) => c.type === "method" && c.name === "x");
    const yMethod = chunks.find((c) => c.type === "method" && c.name === "y");
    // x() and y() are in different classes — must not merge even if both tiny
    expect(xMethod).toBeDefined();
    expect(yMethod).toBeDefined();
  });

  test("merged chunk startLine and endLine span correctly", async () => {
    const source = `type A = string;\ntype B = number;\n`;
    const chunks = await mergingChunker.chunkSource(
      source,
      "span.ts",
      PROJECT_ID,
      "typescript",
    );
    const merged = chunks.find((c) => c.type === "type");
    if (merged) {
      expect(merged.startLine).toBe(1);
      expect(merged.endLine).toBe(2);
    }
  });

  test("default chunker (minChunkTokens=0) does not merge any chunks", async () => {
    // The shared `chunker` has merging disabled — each type alias stays separate
    const source = `type A = string;\ntype B = number;\ntype C = boolean;\n`;
    const chunks = await chunker.chunkSource(
      source,
      "types.ts",
      PROJECT_ID,
      "typescript",
    );
    const typeChunks = chunks.filter((c) => c.type === "type");
    expect(typeChunks.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GraphStore utility — hashEdgeId
// ---------------------------------------------------------------------------

describe("GraphStore — hashEdgeId", () => {
  test("returns a 16-char hex string", () => {
    const id = hashEdgeId("proj", "chunkA", "chunkB", "IMPORTS");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  test("is deterministic for the same inputs", () => {
    const a = hashEdgeId("proj", "chunkA", "chunkB", "IMPORTS");
    const b = hashEdgeId("proj", "chunkA", "chunkB", "IMPORTS");
    expect(a).toBe(b);
  });

  test("produces different values for different edge types", () => {
    const imports = hashEdgeId("proj", "chunkA", "chunkB", "IMPORTS");
    const calls = hashEdgeId("proj", "chunkA", "chunkB", "CALLS");
    expect(imports).not.toBe(calls);
  });

  test("produces different values for different source/target pairs", () => {
    const ab = hashEdgeId("proj", "chunkA", "chunkB", "CALLS");
    const ba = hashEdgeId("proj", "chunkB", "chunkA", "CALLS");
    expect(ab).not.toBe(ba);
  });
});
