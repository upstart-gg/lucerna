import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";

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

describe("YAML", () => {
  const SOURCE = `name: my-app
version: 1.0.0
description: A sample application

dependencies:
  express: "^4.18"
  typescript: "^5.0"

scripts:
  build: tsc
  test: jest

config:
  port: 3000
  host: localhost
`;

  test("detectLanguage: .yaml -> yaml", () => {
    expect(TreeSitterChunker.detectLanguage("foo.yaml")).toBe("yaml");
  });

  test("detectLanguage: .yml -> yaml", () => {
    expect(TreeSitterChunker.detectLanguage("foo.yml")).toBe("yaml");
  });

  test("produces chunks for YAML source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("yaml"),
      PROJECT_ID,
      "yaml",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("splits by top-level keys when > 3 keys", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("yaml"),
      PROJECT_ID,
      "yaml",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("name");
    expect(names).toContain("dependencies");
  });

  test("all chunks have language: yaml", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("yaml"),
      PROJECT_ID,
      "yaml",
    );
    for (const c of chunks) expect(c.language).toBe("yaml");
  });
});
