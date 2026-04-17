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

describe("TOML", () => {
  const SOURCE = `[package]
name = "my-app"
version = "1.0.0"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"

[[bin]]
name = "main"
path = "src/main.rs"
`;

  test("detectLanguage: .toml -> toml", () => {
    expect(TreeSitterChunker.detectLanguage("foo.toml")).toBe("toml");
  });

  test("produces chunks for TOML source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("toml"),
      PROJECT_ID,
      "toml",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("splits by table headers when > 3 tables", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("toml"),
      PROJECT_ID,
      "toml",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("package");
    expect(names).toContain("dependencies");
  });

  test("all chunks have language: toml", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("toml"),
      PROJECT_ID,
      "toml",
    );
    for (const c of chunks) expect(c.language).toBe("toml");
  });
});
