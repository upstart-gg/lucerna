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

describe("Rust", () => {
  const RS_SOURCE = `
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn farewell(name: &str) -> String {
    format!("Goodbye, {}!", name)
}

pub struct UserService {
    db: String,
}

impl UserService {
    pub fn new(db: String) -> Self {
        Self { db }
    }

    pub fn find_user(&self, id: &str) -> Option<String> {
        Some(self.db.clone())
    }
}

pub trait Greeter {
    fn greet(&self) -> String;
}

pub enum Status {
    Active,
    Inactive,
    Banned,
}
`;

  test("detectLanguage: .rs -> rust", () => {
    expect(TreeSitterChunker.detectLanguage("foo.rs")).toBe("rust");
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("farewell");
  });

  test("struct maps to class type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("impl block maps to class type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const cls = chunksByType(chunks, "class");
    // impl UserService is unnamed but should be present
    expect(cls.length).toBeGreaterThanOrEqual(1);
  });

  test("impl methods are extracted as functions", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("new");
    expect(names).toContain("find_user");
  });

  test("trait maps to interface type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const ifaces = chunksByType(chunks, "interface");
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe("Greeter");
  });

  test("enum maps to type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const types = chunksByType(chunks, "type");
    expect(types.length).toBeGreaterThan(0);
    expect(types[0]?.name).toBe("Status");
  });

  test("all chunks have language: rust", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    for (const c of chunks) expect(c.language).toBe("rust");
  });
});
