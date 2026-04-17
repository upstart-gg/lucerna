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

describe("Scala", () => {
  const SOURCE = `import scala.collection.mutable.ListBuffer

trait Greeter {
  def greet(name: String): String
}

class UserService(db: String) extends Greeter {
  def greet(name: String): String = s"Hello, $name!"

  def findUser(id: String): Option[String] = Some(db)
}

object MathUtils {
  def add(a: Int, b: Int): Int = a + b
}
`;

  test("detectLanguage: .scala -> scala", () => {
    expect(TreeSitterChunker.detectLanguage("foo.scala")).toBe("scala");
  });

  test("produces chunks for Scala source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scala"),
      PROJECT_ID,
      "scala",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scala"),
      PROJECT_ID,
      "scala",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("extracts trait as interface", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scala"),
      PROJECT_ID,
      "scala",
    );
    const ifaces = chunksByType(chunks, "interface");
    const names = ifaces.map((c) => c.name);
    expect(names).toContain("Greeter");
  });

  test("emits import chunk", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scala"),
      PROJECT_ID,
      "scala",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
  });

  test("all chunks have language: scala", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scala"),
      PROJECT_ID,
      "scala",
    );
    for (const c of chunks) expect(c.language).toBe("scala");
  });
});
