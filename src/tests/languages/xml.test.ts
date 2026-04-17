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

describe("XML", () => {
  const SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <users>
    <user id="1"><name>Alice</name></user>
  </users>
  <products>
    <product id="1"><name>Widget</name></product>
  </products>
  <orders>
    <order id="1"><userId>1</userId></order>
  </orders>
  <config>
    <setting key="debug">true</setting>
  </config>
</root>
`;

  test("detectLanguage: .xml -> xml", () => {
    expect(TreeSitterChunker.detectLanguage("foo.xml")).toBe("xml");
  });

  test("produces at least one chunk for XML file", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("xml"),
      PROJECT_ID,
      "xml",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains XML data", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("xml"),
      PROJECT_ID,
      "xml",
    );
    const allContent = chunks.map((c: CodeChunk) => c.content).join("\n");
    expect(allContent).toContain("root");
  });

  test("all chunks have language: xml", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("xml"),
      PROJECT_ID,
      "xml",
    );
    for (const c of chunks) expect(c.language).toBe("xml");
  });
});
