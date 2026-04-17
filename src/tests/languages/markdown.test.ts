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

describe("Markdown", () => {
  const MD_SOURCE = `# Getting Started

Welcome to the project. This guide explains how to set things up.

## Installation

Run the following command:

\`\`\`bash
npm install
\`\`\`

## Usage

Import the library and call the API:

\`\`\`typescript
import { MyLib } from "mylib";
const lib = new MyLib();
\`\`\`

## Configuration

Edit the config file before running.
`;

  test("detectLanguage: .md -> markdown", () => {
    expect(TreeSitterChunker.detectLanguage("foo.md")).toBe("markdown");
  });

  test("produces at least one chunk for Markdown file", async () => {
    const chunks = await chunker.chunkSource(
      MD_SOURCE,
      FILE("md"),
      PROJECT_ID,
      "markdown",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains markdown text", async () => {
    const chunks = await chunker.chunkSource(
      MD_SOURCE,
      FILE("md"),
      PROJECT_ID,
      "markdown",
    );
    const allContent = chunks.map((c: CodeChunk) => c.content).join("\n");
    expect(allContent).toContain("Getting Started");
  });

  test("all chunks have language: markdown", async () => {
    const chunks = await chunker.chunkSource(
      MD_SOURCE,
      FILE("md"),
      PROJECT_ID,
      "markdown",
    );
    for (const c of chunks) expect(c.language).toBe("markdown");
  });
});
