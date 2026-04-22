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

  test("struct maps to struct type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const structs = chunksByType(chunks, "struct");
    const names = structs.map((c) => c.name).filter(Boolean);
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

  test("trait maps to trait type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const traits = chunksByType(chunks, "trait");
    expect(traits.length).toBeGreaterThan(0);
    expect(traits[0]?.name).toBe("Greeter");
  });

  test("enum maps to enum type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const enums = chunksByType(chunks, "enum");
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.name).toBe("Status");
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

describe("Rust — modules, macros, consts, type aliases, attribute absorption", () => {
  const SRC = `
/// Module-level documentation about geometry helpers.
pub mod geometry {
    pub fn area(r: f64) -> f64 {
        std::f64::consts::PI * r * r
    }
}

#[macro_export]
macro_rules! say_hello {
    () => { println!("hello"); };
}

pub const MAX_RETRIES: u32 = 5;

pub static GLOBAL_PREFIX: &str = "lucerna://default/prefix/value";

pub type UserId = String;

#[derive(Debug, Clone)]
pub struct Point {
    x: f64,
    y: f64,
}
`.trim();

  test("module emitted as module chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    expect(chunksByType(chunks, "module").map((c) => c.name)).toContain(
      "geometry",
    );
  });

  test("macro_rules! emitted as macro chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    expect(chunksByType(chunks, "macro").map((c) => c.name)).toContain(
      "say_hello",
    );
  });

  test("type alias emitted as typealias chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    expect(chunksByType(chunks, "typealias").map((c) => c.name)).toContain(
      "UserId",
    );
  });

  test("#[derive(...)] attribute absorbed into struct content", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const point = chunksByType(chunks, "struct").find(
      (c) => c.name === "Point",
    );
    expect(point).toBeDefined();
    expect(point?.content).toContain("#[derive(Debug, Clone)]");
  });
});
