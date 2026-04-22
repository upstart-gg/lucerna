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

describe("Svelte", () => {
  const SOURCE = `<script>
  import { onMount } from 'svelte'

  let count = 0
  let title = 'Hello Svelte'

  function increment() {
    count++
  }

  onMount(() => {
    console.log('mounted')
  })
</script>

<h1>{title}</h1>
<button on:click={increment}>Count: {count}</button>
<p>A Svelte component.</p>

<style>
  h1 {
    color: #ff3e00;
  }

  button {
    background: #ff3e00;
    color: white;
  }
</style>
`;

  test("detectLanguage: .svelte -> svelte", () => {
    expect(TreeSitterChunker.detectLanguage("foo.svelte")).toBe("svelte");
  });

  test("produces chunks for Svelte source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("svelte"),
      PROJECT_ID,
      "svelte",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts style block + decomposes script into TS chunks", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("svelte"),
      PROJECT_ID,
      "svelte",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("style");
    // Script block is decomposed into TS/JS chunks: e.g. the `increment`
    // function becomes its own chunk instead of one opaque "script" block.
    expect(names).toContain("increment");
  });

  test("extracts template section for remaining markup", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("svelte"),
      PROJECT_ID,
      "svelte",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("template");
  });

  test("all chunks have language: svelte", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("svelte"),
      PROJECT_ID,
      "svelte",
    );
    for (const c of chunks) expect(c.language).toBe("svelte");
  });
});
