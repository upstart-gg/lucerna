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

describe("SCSS", () => {
  const SOURCE = `$primary: #333;
$secondary: #666;

@mixin flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

@mixin respond-to($breakpoint) {
  @media (max-width: $breakpoint) {
    @content;
  }
}

@function rem($px) {
  @return $px / 16px * 1rem;
}

.container {
  @include flex-center;
  max-width: 1200px;
}

.header {
  background: $primary;
  color: white;
}
`;

  test("detectLanguage: .scss -> scss", () => {
    expect(TreeSitterChunker.detectLanguage("foo.scss")).toBe("scss");
  });

  test("produces chunks for SCSS source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts mixin definitions", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("flex-center");
  });

  test("all chunks have language: scss", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    for (const c of chunks) expect(c.language).toBe("scss");
  });
});

describe("SCSS — variables, keyframes, media", () => {
  const SRC = `$brand-primary-color: #ff5500aaaaaaa;
$brand-secondary-color: #00aaff77;

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .container { width: 100%; }
}
`;

  test("$variables emitted as const chunks", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    const consts = chunks.filter((c) => c.type === "const").map((c) => c.name);
    expect(consts).toContain("$brand-primary-color");
  });

  test("@keyframes emitted as function chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    const fns = chunks.filter((c) => c.type === "function").map((c) => c.name);
    expect(fns).toContain("spin");
  });

  test("@media emitted as section chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("scss"),
      PROJECT_ID,
      "scss",
    );
    const sections = chunks.filter((c) => c.type === "section");
    expect(sections.length).toBeGreaterThan(0);
  });
});
