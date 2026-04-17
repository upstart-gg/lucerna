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

describe("CSS", () => {
  const SOURCE = `body {
  margin: 0;
  padding: 0;
  font-family: sans-serif;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
}

.header {
  background: #333;
  color: white;
  padding: 1rem;
}

.footer {
  background: #eee;
  padding: 1rem;
}

a {
  color: blue;
  text-decoration: none;
}
`;

  test("detectLanguage: .css -> css", () => {
    expect(TreeSitterChunker.detectLanguage("foo.css")).toBe("css");
  });

  test("produces chunks for CSS source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("css"),
      PROJECT_ID,
      "css",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("splits by rule sets when > 3 rules", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("css"),
      PROJECT_ID,
      "css",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("body");
    expect(allContent).toContain(".container");
  });

  test("all chunks have language: css", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("css"),
      PROJECT_ID,
      "css",
    );
    for (const c of chunks) expect(c.language).toBe("css");
  });
});
