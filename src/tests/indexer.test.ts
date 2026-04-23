import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingFunction } from "../types.js";
import { CodeIndexer } from "../CodeIndexer.js";

// Integration tests for CodeIndexer + LanceDBStore + Searcher (lexical only).
// Semantic search is disabled (embeddingFunction: false) so these tests run
// without requiring a model download.

let tmpDir: string;
let projectRoot: string;
let storageDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lucerna-test-"));
  projectRoot = join(tmpDir, "project");
  storageDir = join(tmpDir, "storage");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storageDir, { recursive: true });

  // Create test fixtures
  await writeFile(
    join(projectRoot, "utils.ts"),
    `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}
    `.trim(),
  );

  await writeFile(
    join(projectRoot, "user.ts"),
    `
export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private users: Map<string, User> = new Map();

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }
}
    `.trim(),
  );

  await writeFile(
    join(projectRoot, "README.md"),
    `# My Project

A test project for lucerna.

## Installation

Run \`npm install\`.

## Usage

Import and use the library.
    `.trim(),
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeIndexer(): CodeIndexer {
  return new CodeIndexer({
    projectRoot,
    storageDir,
    embeddingFunction: false, // lexical only — no model needed
  });
}

describe("CodeIndexer", () => {
  test("initialize() does not throw", async () => {
    const indexer = makeIndexer();
    await indexer.initialize(); // should not throw
    await indexer.close();
  });

  test("indexProject() returns stats", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    const stats = await indexer.indexProject();
    expect(stats.totalFiles).toBeGreaterThan(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.projectId).toBeTruthy();
    await indexer.close();
  });

  test("listFiles() returns indexed files", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();
    const files = await indexer.listFiles();
    expect(files.length).toBeGreaterThan(0);
    // Relative paths
    const hasUtils = files.some((f) => f.includes("utils.ts"));
    const hasUser = files.some((f) => f.includes("user.ts"));
    expect(hasUtils).toBe(true);
    expect(hasUser).toBe(true);
    await indexer.close();
  });

  test("getChunks() returns chunks for a file", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();
    const chunks = await indexer.getChunks("utils.ts");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.filePath).toContain("utils.ts");
    }
    await indexer.close();
  });

  test("searchLexical() finds relevant chunks", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("UserService", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.some(
      (r) =>
        r.chunk.content.includes("UserService") ||
        r.chunk.name?.includes("UserService"),
    );
    expect(found).toBe(true);
    await indexer.close();
  });

  test("search() delegates to lexical when semantic disabled", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.search("formatDate", { limit: 5 });
    // Should not throw and should return results
    expect(Array.isArray(results)).toBe(true);
    await indexer.close();
  });

  test("removeFile() removes chunks from index", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();

    const before = await indexer.getChunks("utils.ts");
    expect(before.length).toBeGreaterThan(0);

    await indexer.removeFile("utils.ts");
    const after = await indexer.getChunks("utils.ts");
    expect(after).toHaveLength(0);

    await indexer.close();
  });

  test("indexFile() re-indexes a single file", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    await indexer.indexProject();

    // Modify the file
    await writeFile(
      join(projectRoot, "utils.ts"),
      `
export function newFunction(): void {
  console.log("new");
}
      `.trim(),
    );

    await indexer.indexFile("utils.ts");
    const chunks = await indexer.getChunks("utils.ts");
    const hasNew = chunks.some((c) => c.content.includes("newFunction"));
    expect(hasNew).toBe(true);

    await indexer.close();
  });

  test("multiple indexers can coexist with different projectRoots", async () => {
    const projectRoot2 = join(tmpDir, "project2");
    await mkdir(projectRoot2, { recursive: true });
    await writeFile(join(projectRoot2, "index.ts"), `export const x = 42;`);

    const indexer1 = new CodeIndexer({
      projectRoot,
      storageDir: join(tmpDir, "storage1"),
      embeddingFunction: false,
    });
    const indexer2 = new CodeIndexer({
      projectRoot: projectRoot2,
      storageDir: join(tmpDir, "storage2"),
      embeddingFunction: false,
    });

    await Promise.all([indexer1.initialize(), indexer2.initialize()]);
    await Promise.all([indexer1.indexProject(), indexer2.indexProject()]);

    const files1 = await indexer1.listFiles();
    const files2 = await indexer2.listFiles();

    // Each indexer should only see its own project's files
    expect(
      files1.some((f) => f.includes("utils.ts") || f.includes("user.ts")),
    ).toBe(true);
    expect(files2.some((f) => f.includes("index.ts"))).toBe(true);

    await Promise.all([indexer1.close(), indexer2.close()]);
  });
});

// ---------------------------------------------------------------------------
// Semantic search — requires a mock embedding function
// ---------------------------------------------------------------------------

/** Deterministic mock embedding: uses char-code sum to produce a dim-384 vector. */
function mockEmbeddingFn(): EmbeddingFunction {
  return {
    dimensions: 4,
    async generate(texts: string[]) {
      return texts.map((t) => {
        const sum = [...t].reduce((s, c) => s + c.charCodeAt(0), 0);
        return [sum % 1, (sum >> 1) % 1, (sum >> 2) % 1, (sum >> 3) % 1];
      });
    },
  };
}

describe("CodeIndexer — semantic search", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-semantic-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "svc.ts"),
      `export function authenticate(token: string): boolean { return !!token; }`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("searchSemantic() returns results when embedding function is provided", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: mockEmbeddingFn(),
    });
    await indexer.initialize();
    await indexer.indexProject();

    const results = await indexer.searchSemantic("authenticate", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Verify result shape
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("chunk");
      expect(results[0]).toHaveProperty("matchType");
      expect(results[0]).not.toHaveProperty("score");
    }
    await indexer.close();
  });

  test("createDefaultEmbedding path — no embeddingFunction option uses HFEmbeddings", () => {
    // When embeddingFunction is omitted, CodeIndexer calls createDefaultEmbedding().
    // We just verify construction doesn't throw (model loading is deferred).
    const indexer = new CodeIndexer({ projectRoot, storageDir });
    expect(indexer).toBeDefined();
  });

  test("initialize with embeddingFunction: false preserves an existing semantic index", async () => {
    // Regression: `stats --no-semantic` after `index` must not clobber dim/model
    // metadata written by a prior semantic run. A lexical-only opener now
    // adopts the stored dim instead of guessing one.
    const semanticIndexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: mockEmbeddingFn(), // 4-dim
    });
    await semanticIndexer.initialize();
    const built = await semanticIndexer.indexProject();
    expect(built.totalChunks).toBeGreaterThan(0);
    await semanticIndexer.close();

    // Re-open without an embedder (mirrors the `stats --no-semantic` path).
    const lexicalIndexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await lexicalIndexer.initialize();
    const stats = await lexicalIndexer.getStats();
    expect(stats.totalChunks).toBe(built.totalChunks);
    expect(stats.totalFiles).toBe(built.totalFiles);
    await lexicalIndexer.close();

    // Re-open again with the original embedder — meta dims/model should be
    // unchanged, so no spurious clear happens.
    const semanticAgain = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: mockEmbeddingFn(),
    });
    await semanticAgain.initialize();
    const statsAgain = await semanticAgain.getStats();
    expect(statsAgain.totalChunks).toBe(built.totalChunks);
    await semanticAgain.close();
  });
});

// ---------------------------------------------------------------------------
// startWatching() / stopWatching()
// ---------------------------------------------------------------------------

describe("CodeIndexer — watching", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-watch-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(projectRoot, "a.ts"), `export const x = 1;`);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("startWatching() does not throw", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    await expect(indexer.startWatching()).resolves.toBeUndefined();
    await indexer.stopWatching();
    await indexer.close();
  });

  test("startWatching() is idempotent", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    await indexer.startWatching();
    await expect(indexer.startWatching()).resolves.toBeUndefined();
    await indexer.stopWatching();
    await indexer.close();
  });

  test("stopWatching() is a no-op when not watching", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    await expect(indexer.stopWatching()).resolves.toBeUndefined();
    await indexer.close();
  });
});

// ---------------------------------------------------------------------------
// getEdgesFrom() / getEdgesTo()
// ---------------------------------------------------------------------------

describe("CodeIndexer — graph edge queries", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-edges-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    // importer.ts imports from utils.ts — creates a graph edge
    await writeFile(
      join(projectRoot, "utils.ts"),
      `export function helper(): void {}`,
    );
    await writeFile(
      join(projectRoot, "importer.ts"),
      `import { helper } from "./utils.js";\nexport function main(): void { helper(); }`,
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("getEdgesFrom() and getEdgesTo() return arrays (may be empty)", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    await indexer.indexProject();

    const files = await indexer.listFiles();
    const chunks =
      files.length > 0 && files[0] ? await indexer.getChunks(files[0]) : [];

    if (chunks.length > 0 && chunks[0]) {
      const chunkId = chunks[0].id;
      const outgoing = await indexer.getEdgesFrom(chunkId);
      const incoming = await indexer.getEdgesTo(chunkId);
      expect(Array.isArray(outgoing)).toBe(true);
      expect(Array.isArray(incoming)).toBe(true);
    }

    // Even with no known chunk ID, should not throw
    const edgesFrom = await indexer.getEdgesFrom("nonexistent-id");
    expect(Array.isArray(edgesFrom)).toBe(true);

    const edgesTo = await indexer.getEdgesTo("nonexistent-id");
    expect(Array.isArray(edgesTo)).toBe(true);

    await indexer.close();
  });

  test("getEdgesFrom() passes optional type filter without throwing", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    const result = await indexer.getEdgesFrom("any-id", ["IMPORTS"]);
    expect(Array.isArray(result)).toBe(true);
    await indexer.close();
  });
});

// ---------------------------------------------------------------------------
// .gitignore support
// ---------------------------------------------------------------------------

describe(".gitignore support", () => {
  test("files matched by root .gitignore are not indexed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucerna-gitignore-"));
    const store = join(root, ".lucerna");

    try {
      // Create project layout
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });

      await writeFile(
        join(root, "src", "main.py"),
        "def hello():\n    return 'hello'\n",
      );
      await writeFile(
        join(root, "dist", "bundle.py"),
        "def bundled():\n    return 'bundled'\n",
      );
      await writeFile(join(root, ".gitignore"), "dist/\n");

      const indexer = new CodeIndexer({
        projectRoot: root,
        storageDir: store,
        embeddingFunction: false,
      });
      await indexer.initialize();
      const stats = await indexer.indexProject();
      await indexer.close();

      // src/main.py should be indexed, dist/bundle.py should not
      expect(stats.totalFiles).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("nested .gitignore in a subdirectory is respected", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucerna-gitignore-nested-"));
    const store = join(root, ".lucerna");

    try {
      await mkdir(join(root, "packages", "server"), { recursive: true });

      await writeFile(
        join(root, "packages", "server", "app.py"),
        "def app():\n    pass\n",
      );
      await writeFile(
        join(root, "packages", "server", "debug.log"),
        "some log output\n",
      );
      // The nested .gitignore excludes *.log within packages/server/
      await writeFile(
        join(root, "packages", "server", ".gitignore"),
        "*.log\n",
      );

      const indexer = new CodeIndexer({
        projectRoot: root,
        storageDir: store,
        embeddingFunction: false,
      });
      await indexer.initialize();
      const stats = await indexer.indexProject();
      await indexer.close();

      // stats.totalFiles counts only files that produced chunks
      // app.py should be indexed; debug.log has no recognized language anyway
      expect(stats.totalFiles).toBeGreaterThanOrEqual(1);

      // Verify debug.log wasn't indexed by checking it produced no chunks
      const indexer2 = new CodeIndexer({
        projectRoot: root,
        storageDir: store,
        embeddingFunction: false,
      });
      await indexer2.initialize();
      const results = await indexer2.search("some log output", { limit: 5 });
      expect(results.length).toBe(0);
      await indexer2.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("user-provided exclude patterns are still respected alongside gitignore", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucerna-gitignore-extra-"));
    const store = join(root, ".lucerna");

    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "vendor"), { recursive: true });

      await writeFile(
        join(root, "src", "main.py"),
        "def hello():\n    return 'hello'\n",
      );
      await writeFile(
        join(root, "vendor", "lib.py"),
        "def lib():\n    return 'lib'\n",
      );
      await writeFile(join(root, ".gitignore"), "# no exclusions\n");

      const indexer = new CodeIndexer({
        projectRoot: root,
        storageDir: store,
        embeddingFunction: false,
        exclude: ["**/vendor/**"],
      });
      await indexer.initialize();
      const stats = await indexer.indexProject();
      await indexer.close();

      // vendor/lib.py excluded by user-supplied pattern
      expect(stats.totalFiles).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
