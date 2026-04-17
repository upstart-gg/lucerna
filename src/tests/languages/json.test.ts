import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";
import type { CodeChunk } from "../../types.js";

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

describe("JSON", () => {
  const JSON_SOURCE = `{
  "name": "my-package",
  "version": "1.0.0",
  "description": "A sample package",
  "scripts": {
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
`;

  test("detectLanguage: .json -> json", () => {
    expect(TreeSitterChunker.detectLanguage("foo.json")).toBe("json");
  });

  test("produces at least one chunk for JSON file", async () => {
    const chunks = await chunker.chunkSource(
      JSON_SOURCE,
      FILE("json"),
      PROJECT_ID,
      "json",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains JSON data", async () => {
    const chunks = await chunker.chunkSource(
      JSON_SOURCE,
      FILE("json"),
      PROJECT_ID,
      "json",
    );
    const allContent = chunks.map((c: CodeChunk) => c.content).join("\n");
    expect(allContent).toContain("my-package");
  });

  test("all chunks have language: json", async () => {
    const chunks = await chunker.chunkSource(
      JSON_SOURCE,
      FILE("json"),
      PROJECT_ID,
      "json",
    );
    for (const c of chunks) expect(c.language).toBe("json");
  });
});
