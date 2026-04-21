import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../store/SqliteVectorStore.js";
import type { CodeChunk } from "../types.js";

// Use small vectors so tests run fast
const DIMS = 8;

function makeChunk(
  id: string,
  filePath: string,
  content: string,
  overrides: Partial<CodeChunk> = {},
): CodeChunk {
  return {
    id,
    projectId: "test-project",
    filePath,
    language: "typescript",
    type: "function",
    name: `fn_${id}`,
    content,
    contextContent: content,
    startLine: 1,
    endLine: 10,
    metadata: {},
    ...overrides,
  };
}

function makeVector(dims: number, value = 0.5): number[] {
  return new Array(dims).fill(value);
}

describe("SqliteVectorStore", () => {
  let tmpDir: string;
  let store: SqliteVectorStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sqlite-store-test-"));
    store = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  test("initialize() creates an empty table", async () => {
    expect(await store.count()).toBe(0);
  });

  test("initialize() on existing storage opens the existing table", async () => {
    const chunk = makeChunk("id1", "src/a.ts", "function a() {}");
    await store.upsert([chunk], [makeVector(DIMS)]);
    await store.close();

    const store2 = new SqliteVectorStore({
      storageDir: tmpDir,
      dimensions: DIMS,
    });
    await store2.initialize();
    expect(await store2.count()).toBe(1);
    await store2.close();
  });

  test("initialize() throws a clear error when stored vector dim differs from configured dim", async () => {
    const chunk = makeChunk("id1", "src/a.ts", "function a() {}");
    await store.upsert([chunk], [makeVector(DIMS)]);
    await store.close();

    const store2 = new SqliteVectorStore({
      storageDir: tmpDir,
      dimensions: DIMS * 2,
    });
    await expect(store2.initialize()).rejects.toThrow(/dimension mismatch/i);
  });

  // -------------------------------------------------------------------------
  // upsert()
  // -------------------------------------------------------------------------

  test("upsert() adds chunks", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "function a() {}"),
      makeChunk("id2", "src/b.ts", "function b() {}"),
    ];
    await store.upsert(chunks, [makeVector(DIMS, 0.1), makeVector(DIMS, 0.9)]);
    expect(await store.count()).toBe(2);
  });

  test("upsert() is a no-op for empty array", async () => {
    await store.upsert([], []);
    expect(await store.count()).toBe(0);
  });

  test("upsert() replaces existing chunk with same id", async () => {
    const chunk = makeChunk("id1", "src/a.ts", "original content");
    await store.upsert([chunk], [makeVector(DIMS)]);

    const updated = makeChunk("id1", "src/a.ts", "updated content");
    await store.upsert([updated], [makeVector(DIMS)]);

    expect(await store.count()).toBe(1);
    const chunks = await store.getChunksByFile("src/a.ts");
    expect(chunks[0]?.content).toBe("updated content");
  });

  // -------------------------------------------------------------------------
  // delete() by IDs
  // -------------------------------------------------------------------------

  test("delete() removes the specified chunk IDs", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "function a() {}"),
      makeChunk("id2", "src/b.ts", "function b() {}"),
      makeChunk("id3", "src/c.ts", "function c() {}"),
    ];
    await store.upsert(chunks, [
      makeVector(DIMS),
      makeVector(DIMS),
      makeVector(DIMS),
    ]);

    await store.delete(["id1", "id3"]);
    expect(await store.count()).toBe(1);

    const remaining = await store.listFiles();
    expect(remaining).toContain("src/b.ts");
    expect(remaining).not.toContain("src/a.ts");
    expect(remaining).not.toContain("src/c.ts");
  });

  test("delete() is a no-op for empty ids array", async () => {
    await store.upsert(
      [makeChunk("id1", "src/a.ts", "fn")],
      [makeVector(DIMS)],
    );
    await store.delete([]);
    expect(await store.count()).toBe(1);
  });

  test("delete() is a no-op when not initialized", async () => {
    const raw = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    await expect(raw.delete(["id1"])).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // deleteByFile()
  // -------------------------------------------------------------------------

  test("deleteByFile() removes all chunks for a file", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "fn a1"),
      makeChunk("id2", "src/a.ts", "fn a2"),
      makeChunk("id3", "src/b.ts", "fn b"),
    ];
    await store.upsert(chunks, [
      makeVector(DIMS),
      makeVector(DIMS),
      makeVector(DIMS),
    ]);

    await store.deleteByFile("src/a.ts");
    expect(await store.count()).toBe(1);
    expect(await store.listFiles()).toEqual(["src/b.ts"]);
  });

  // -------------------------------------------------------------------------
  // searchVector()
  // -------------------------------------------------------------------------

  test("searchVector() returns results with matchType=semantic", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "function alpha() {}"),
      makeChunk("id2", "src/b.ts", "function beta() {}"),
    ];
    const v1 = [1, 0, 0, 0, 0, 0, 0, 0];
    const v2 = [0, 1, 0, 0, 0, 0, 0, 0];
    await store.upsert(chunks, [v1, v2]);

    const results = await store.searchVector([1, 0, 0, 0, 0, 0, 0, 0], {
      limit: 2,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.matchType).toBe("semantic");
    expect(typeof results[0]?.score).toBe("number");
  });

  test("searchVector() respects the limit option", async () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`id${i}`, `src/${i}.ts`, `fn ${i}`),
    );
    await store.upsert(
      chunks,
      chunks.map(() => makeVector(DIMS)),
    );

    const results = await store.searchVector(makeVector(DIMS), { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("searchVector() with filePath filter narrows results", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "function a() {}"),
      makeChunk("id2", "src/b.ts", "function b() {}"),
    ];
    await store.upsert(chunks, [makeVector(DIMS, 0.1), makeVector(DIMS, 0.9)]);

    const results = await store.searchVector(makeVector(DIMS), {
      limit: 10,
      filePath: "src/a.ts",
    });
    for (const r of results) {
      expect(r.chunk.filePath).toBe("src/a.ts");
    }
  });

  test("searchVector() with language filter narrows results", async () => {
    const tsChunk = makeChunk("id1", "src/a.ts", "fn", {
      language: "typescript",
    });
    const jsChunk = makeChunk("id2", "src/b.js", "fn", {
      language: "javascript",
    });
    await store.upsert(
      [tsChunk, jsChunk],
      [makeVector(DIMS), makeVector(DIMS)],
    );

    const results = await store.searchVector(makeVector(DIMS), {
      language: "typescript",
    });
    for (const r of results) {
      expect(r.chunk.language).toBe("typescript");
    }
  });

  test("searchVector() with type filter narrows results", async () => {
    const fn = makeChunk("id1", "src/a.ts", "fn", { type: "function" });
    const cls = makeChunk("id2", "src/b.ts", "class", { type: "class" });
    await store.upsert([fn, cls], [makeVector(DIMS), makeVector(DIMS)]);

    const results = await store.searchVector(makeVector(DIMS), {
      types: ["function"],
    });
    for (const r of results) {
      expect(r.chunk.type).toBe("function");
    }
  });

  test("searchVector() throws when not initialized", async () => {
    const raw = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    await expect(raw.searchVector(makeVector(DIMS), {})).rejects.toThrow(
      "not initialized",
    );
  });

  // -------------------------------------------------------------------------
  // searchText()
  // -------------------------------------------------------------------------

  test("searchText() throws when not initialized", async () => {
    const raw = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    await expect(raw.searchText("hello", {})).rejects.toThrow(
      "not initialized",
    );
  });

  // -------------------------------------------------------------------------
  // getChunksByIds()
  // -------------------------------------------------------------------------

  test("getChunksByIds() returns chunks by their IDs", async () => {
    const chunks = [
      makeChunk("id1", "src/a.ts", "fn a"),
      makeChunk("id2", "src/b.ts", "fn b"),
    ];
    await store.upsert(chunks, [makeVector(DIMS), makeVector(DIMS)]);

    const found = await store.getChunksByIds(["id1"]);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("id1");
  });

  test("getChunksByIds() returns empty array for empty ids", async () => {
    expect(await store.getChunksByIds([])).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // listFiles() / count()
  // -------------------------------------------------------------------------

  test("listFiles() returns sorted unique file paths", async () => {
    const chunks = [
      makeChunk("id1", "src/z.ts", "fn"),
      makeChunk("id2", "src/a.ts", "fn"),
      makeChunk("id3", "src/a.ts", "fn2"),
    ];
    await store.upsert(chunks, [
      makeVector(DIMS),
      makeVector(DIMS),
      makeVector(DIMS),
    ]);

    const files = await store.listFiles();
    expect(files).toEqual(["src/a.ts", "src/z.ts"]);
  });

  test("listFiles() returns empty array when uninitialized", async () => {
    const raw = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    expect(await raw.listFiles()).toEqual([]);
  });

  test("count() returns 0 when uninitialized", async () => {
    const raw = new SqliteVectorStore({ storageDir: tmpDir, dimensions: DIMS });
    expect(await raw.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // searchHybrid()
  // -------------------------------------------------------------------------

  describe("searchHybrid()", () => {
    test("returns empty array when store is empty", async () => {
      const results = await store.searchHybrid(
        makeVector(DIMS),
        "authentication",
        { limit: 10 },
      );
      expect(results).toEqual([]);
    });

    test("returns results with matchType=hybrid and numeric score", async () => {
      const chunks = [
        makeChunk("id1", "src/a.ts", "function authenticate(token: string) {}"),
        makeChunk("id2", "src/b.ts", "const PI = 3.14159"),
      ];
      await store.upsert(chunks, [
        makeVector(DIMS, 0.9),
        makeVector(DIMS, 0.1),
      ]);

      const results = await store.searchHybrid(
        makeVector(DIMS, 0.9),
        "authenticate",
        { limit: 10 },
      );
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.matchType).toBe("hybrid");
        expect(typeof r.score).toBe("number");
        expect(r.score).toBeGreaterThanOrEqual(0);
      }
    });

    test("respects the limit option", async () => {
      const chunks = Array.from({ length: 5 }, (_, i) =>
        makeChunk(`id${i}`, `src/${i}.ts`, `function fn${i}() {}`),
      );
      await store.upsert(
        chunks,
        chunks.map(() => makeVector(DIMS)),
      );

      const results = await store.searchHybrid(makeVector(DIMS), "fn", {
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("filePath filter narrows results", async () => {
      const chunks = [
        makeChunk("id1", "src/a.ts", "function alpha() {}"),
        makeChunk("id2", "src/b.ts", "function beta() {}"),
      ];
      await store.upsert(chunks, [
        makeVector(DIMS, 0.8),
        makeVector(DIMS, 0.2),
      ]);

      const results = await store.searchHybrid(makeVector(DIMS), "function", {
        limit: 10,
        filePath: "src/a.ts",
      });
      for (const r of results) {
        expect(r.chunk.filePath).toBe("src/a.ts");
      }
    });

    test("result chunks have correct ids and file paths", async () => {
      const chunks = [
        makeChunk(
          "chunk-abc",
          "src/auth.ts",
          "function login(user: string) {}",
        ),
      ];
      await store.upsert(chunks, [makeVector(DIMS)]);

      const results = await store.searchHybrid(makeVector(DIMS), "login", {
        limit: 5,
      });
      const ids = results.map((r) => r.chunk.id);
      expect(ids).toContain("chunk-abc");
    });
  });

  // -------------------------------------------------------------------------
  // optimize()
  // -------------------------------------------------------------------------

  describe("optimize()", () => {
    test("is a no-op on an empty store", async () => {
      await expect(store.optimize()).resolves.toBeUndefined();
      expect(await store.count()).toBe(0);
    });

    test("FTS index supports searches without extra bootstrapping", async () => {
      const chunks = [
        makeChunk("id1", "src/a.ts", "function authenticate() {}"),
        makeChunk("id2", "src/b.ts", "function logout() {}"),
      ];
      await store.upsert(chunks, [makeVector(DIMS), makeVector(DIMS)]);
      await store.optimize();

      const results = await store.searchText("authenticate", { limit: 5 });
      expect(results.map((r) => r.chunk.id)).toContain("id1");
    });

    test("is idempotent — repeated calls succeed", async () => {
      const chunk = makeChunk("id1", "src/a.ts", "function foo() {}");
      await store.upsert([chunk], [makeVector(DIMS)]);
      await store.optimize();
      await expect(store.optimize()).resolves.toBeUndefined();
    });
  });
});
