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

describe("Java", () => {
  const JAVA_SOURCE = `import java.util.List;
import java.util.Optional;

public interface Greeter {
    String greet(String name);
}

public class UserService implements Greeter {
    private final String db;

    public UserService(String db) {
        this.db = db;
    }

    @Override
    public String greet(String name) {
        return "Hello, " + name + "!";
    }

    public String findUser(String id) {
        return db;
    }
}
`;

  test("detectLanguage: .java -> java", () => {
    expect(TreeSitterChunker.detectLanguage("Foo.java")).toBe("java");
  });

  test("extracts interface", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const ifaces = chunksByType(chunks, "interface");
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe("Greeter");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const cls = chunksByType(chunks, "class");
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
  });

  test("extracts methods as children", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("findUser");
  });

  test("emits import chunk for import statements", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("java.util");
  });

  test("all chunks have language: java", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    for (const c of chunks) expect(c.language).toBe("java");
  });
});
