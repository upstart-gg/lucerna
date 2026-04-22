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

describe("Vue", () => {
  const SOURCE = `<template>
  <div class="app">
    <h1>{{ title }}</h1>
    <button @click="increment">Count: {{ count }}</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const title = 'Hello Vue'
const count = ref(0)

function increment() {
  count.value++
}
</script>

<style scoped>
.app {
  font-family: sans-serif;
}

h1 {
  color: #333;
}
</style>
`;

  test("detectLanguage: .vue -> vue", () => {
    expect(TreeSitterChunker.detectLanguage("foo.vue")).toBe("vue");
  });

  test("produces chunks for Vue source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("vue"),
      PROJECT_ID,
      "vue",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts template + style sections, decomposes script", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("vue"),
      PROJECT_ID,
      "vue",
    );
    const names = chunks.map((c) => c.name);
    expect(names).toContain("template");
    expect(names).toContain("style");
    // Script block decomposes into individual TS chunks, e.g. `increment`
    expect(names).toContain("increment");
  });

  test("all chunks have language: vue", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("vue"),
      PROJECT_ID,
      "vue",
    );
    for (const c of chunks) expect(c.language).toBe("vue");
  });
});
