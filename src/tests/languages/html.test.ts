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

describe("HTML", () => {
  const SOURCE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sample</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Hello World</h1>
  </header>
  <main>
    <p>Content goes here.</p>
  </main>
  <footer>
    <p>Footer</p>
  </footer>
</body>
</html>
`;

  test("detectLanguage: .html -> html", () => {
    expect(TreeSitterChunker.detectLanguage("foo.html")).toBe("html");
  });

  test("detectLanguage: .htm -> html", () => {
    expect(TreeSitterChunker.detectLanguage("foo.htm")).toBe("html");
  });

  test("produces chunks for HTML source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("html"),
      PROJECT_ID,
      "html",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains HTML elements", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("html"),
      PROJECT_ID,
      "html",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("html");
  });

  test("all chunks have language: html", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("html"),
      PROJECT_ID,
      "html",
    );
    for (const c of chunks) expect(c.language).toBe("html");
  });
});
