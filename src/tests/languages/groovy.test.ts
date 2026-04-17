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

describe("Groovy", () => {
  const SOURCE = `import groovy.transform.CompileStatic

interface Greeter {
    String greet(String name)
}

@CompileStatic
class UserService implements Greeter {
    private String db

    UserService(String db) {
        this.db = db
    }

    @Override
    String greet(String name) {
        "Hello, \${name}!"
    }

    String findUser(String id) {
        db
    }
}

def farewell(String name) {
    "Goodbye, \${name}!"
}
`;

  test("detectLanguage: .groovy -> groovy", () => {
    expect(TreeSitterChunker.detectLanguage("foo.groovy")).toBe("groovy");
  });

  test("produces chunks for Groovy source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("groovy"),
      PROJECT_ID,
      "groovy",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains class source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("groovy"),
      PROJECT_ID,
      "groovy",
    );
    // Groovy falls back to a whole-file chunk
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("UserService");
  });

  test("all chunks have language: groovy", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("groovy"),
      PROJECT_ID,
      "groovy",
    );
    for (const c of chunks) expect(c.language).toBe("groovy");
  });
});
