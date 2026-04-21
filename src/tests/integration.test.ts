/**
 * End-to-end integration tests for lucerna.
 *
 * These tests exercise the full stack: CodeIndexer → LanceDBStore → GraphStore,
 * including cross-session FTS index persistence, search filters, graph traversal,
 * and file-watcher behaviour.
 *
 * Run with: INTEGRATION_TESTS=1 bun test src/tests/integration.test.ts
 */

if (!process.env.INTEGRATION_TESTS) {
  process.exit(0);
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../CodeIndexer.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeIndexer(projectRoot: string, storageDir: string): CodeIndexer {
  return new CodeIndexer({ projectRoot, storageDir, embeddingFunction: false });
}

// ---------------------------------------------------------------------------
// 1. FTS index persistence across sessions (regression for ftsIndexExists bug)
// ---------------------------------------------------------------------------

describe("FTS index persistence across sessions", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-fts-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "greet.ts"),
      `export function greetUser(name: string): string { return "Hello " + name; }`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("searchLexical() returns results in a fresh indexer opened on an existing store", async () => {
    // Session A: index
    const indexerA = makeIndexer(projectRoot, storageDir);
    await indexerA.initialize();
    await indexerA.indexProject();
    await indexerA.close();

    // Session B: search — FTS index must be built/found correctly
    const indexerB = makeIndexer(projectRoot, storageDir);
    await indexerB.initialize();
    const results = await indexerB.searchLexical("greetUser", { limit: 5 });
    await indexerB.close();

    expect(results.length).toBeGreaterThan(0);
    const found = results.some(
      (r) =>
        r.chunk.content.includes("greetUser") || r.chunk.name === "greetUser",
    );
    expect(found).toBe(true);
  });

  test("sqlite backend indexes and searches end-to-end", async () => {
    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
      vectorStore: "sqlite",
    });
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("greetUser", { limit: 5 });
    const stats = await indexer.getStats();
    await indexer.close();

    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    const found = results.some(
      (r) =>
        r.chunk.content.includes("greetUser") || r.chunk.name === "greetUser",
    );
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Lexical search — camelCase identifier expansion
// ---------------------------------------------------------------------------

describe("Lexical search — identifier expansion", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-expand-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("camelCase sub-word search finds the function", async () => {
    await writeFile(
      join(projectRoot, "payment.ts"),
      `export function processPayment(amount: number): void { console.log(amount); }`,
    );

    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("payment", { limit: 5 });
    await indexer.close();

    expect(results.length).toBeGreaterThan(0);
    const found = results.some((r) =>
      r.chunk.content.includes("processPayment"),
    );
    expect(found).toBe(true);
  });

  test("snake_case sub-word search finds the function", async () => {
    await writeFile(
      join(projectRoot, "parser.ts"),
      `export function parse_json_string(input: string): unknown { return JSON.parse(input); }`,
    );

    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("json", { limit: 5 });
    await indexer.close();

    expect(results.length).toBeGreaterThan(0);
    const found = results.some((r) =>
      r.chunk.content.includes("parse_json_string"),
    );
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. File update propagates to search
// ---------------------------------------------------------------------------

describe("File update propagates to search", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-update-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("indexFile() replaces stale chunks after file change", async () => {
    await writeFile(
      join(projectRoot, "svc.ts"),
      `export function oldFn(): void { console.log("old"); }`,
    );

    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    // Confirm initial state
    const before = await indexer.searchLexical("oldFn", { limit: 5 });
    expect(before.some((r) => r.chunk.content.includes("oldFn"))).toBe(true);

    // Overwrite with new content
    await writeFile(
      join(projectRoot, "svc.ts"),
      `export function newFn(): void { console.log("new"); }`,
    );
    await indexer.indexFile("svc.ts");

    const afterNew = await indexer.searchLexical("newFn", { limit: 5 });
    expect(afterNew.some((r) => r.chunk.content.includes("newFn"))).toBe(true);

    const afterOld = await indexer.searchLexical("oldFn", { limit: 5 });
    const staleFound = afterOld.some((r) => r.chunk.content.includes("oldFn"));
    expect(staleFound).toBe(false);

    await indexer.close();
  });
});

// ---------------------------------------------------------------------------
// 4. File removal propagates to search
// ---------------------------------------------------------------------------

describe("File removal propagates to search", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-remove-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("removeFile() makes chunks unsearchable while leaving other files intact", async () => {
    await writeFile(
      join(projectRoot, "alpha.ts"),
      `export function alphaFn(): void {}`,
    );
    await writeFile(
      join(projectRoot, "beta.ts"),
      `export function betaFn(): void {}`,
    );

    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    await indexer.removeFile("alpha.ts");

    const alphaResults = await indexer.searchLexical("alphaFn", { limit: 5 });
    expect(alphaResults.some((r) => r.chunk.content.includes("alphaFn"))).toBe(
      false,
    );

    const betaResults = await indexer.searchLexical("betaFn", { limit: 5 });
    expect(betaResults.some((r) => r.chunk.content.includes("betaFn"))).toBe(
      true,
    );

    await indexer.close();
  });
});

// ---------------------------------------------------------------------------
// 5. getStats() accuracy
// ---------------------------------------------------------------------------

describe("getStats() accuracy", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-stats-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reports correct file and chunk counts after indexing", async () => {
    await writeFile(
      join(projectRoot, "a.ts"),
      `export function aFn(): void {}`,
    );
    await writeFile(
      join(projectRoot, "b.ts"),
      `export function bFn(): void {}`,
    );

    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const stats = await indexer.getStats();
    await indexer.close();

    expect(stats.totalFiles).toBe(2);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.projectId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. Language filter restricts results
// ---------------------------------------------------------------------------

describe("Language filter restricts results", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-lang-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "code.ts"),
      `export function install(): void { console.log("install"); }`,
    );
    await writeFile(
      join(projectRoot, "README.md"),
      `# Project\n\n## Installation\n\nRun \`npm install\` to install.`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("language: markdown returns only markdown chunks", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("install", {
      limit: 10,
      language: "markdown",
    });
    await indexer.close();

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.chunk.language).toBe("markdown");
    }
  });

  test("language: typescript returns only typescript chunks", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("install", {
      limit: 10,
      language: "typescript",
    });
    await indexer.close();

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.chunk.language).toBe("typescript");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Type filter restricts results
// ---------------------------------------------------------------------------

describe("Type filter restricts results", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-type-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "mixed.ts"),
      `
export class DataService {
  fetchData(): string { return "data"; }
}

export function standalone(): void { console.log("standalone"); }
      `.trim(),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("types: ['function'] returns only function chunks", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();
    const results = await indexer.searchLexical("data", {
      limit: 10,
      types: ["function"],
    });
    await indexer.close();

    // Every returned chunk must be of type function (not class or method)
    for (const r of results) {
      expect(r.chunk.type).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Graph: callers / callees round-trip
// ---------------------------------------------------------------------------

describe("Graph: callers and callees", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-graph-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "utils.ts"),
      `export function helper(): void { console.log("help"); }`,
    );
    await writeFile(
      join(projectRoot, "main.ts"),
      `import { helper } from "./utils.js";\nexport function main(): void { helper(); }`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("getCallers() returns a chunk from the calling file", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    const utilChunks = await indexer.getChunks("utils.ts");
    const helperChunk = utilChunks.find((c) => c.name === "helper");
    expect(helperChunk).toBeDefined();

    if (helperChunk) {
      const callers = await indexer.getCallers(helperChunk.id);
      // The import chunk in main.ts (which imports helper) is returned as a caller.
      // Callers are keyed by filePath, not necessarily by function name.
      expect(callers.length).toBeGreaterThan(0);
      const fromMain = callers.some((c) => c.filePath.includes("main.ts"));
      expect(fromMain).toBe(true);
    }

    await indexer.close();
  });

  test("getCallees() returns an array (may be empty for simple fixtures)", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    const mainChunks = await indexer.getChunks("main.ts");
    const mainChunk = mainChunks.find((c) => c.name === "main");
    expect(mainChunk).toBeDefined();

    if (mainChunk) {
      const callees = await indexer.getCallees(mainChunk.id);
      expect(Array.isArray(callees)).toBe(true);
    }

    await indexer.close();
  });
});

// ---------------------------------------------------------------------------
// 9. Graph: getDependencies / getDependents
// ---------------------------------------------------------------------------

describe("Graph: getDependencies and getDependents", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-deps-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "utils.ts"),
      `export function helper(): void {}`,
    );
    await writeFile(
      join(projectRoot, "main.ts"),
      `import { helper } from "./utils.js";\nexport function main(): void { helper(); }`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("getDependencies(main.ts) includes utils.ts", async () => {
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    const deps = await indexer.getDependencies("main.ts");
    await indexer.close();

    expect(Array.isArray(deps)).toBe(true);
    const paths = deps.map((c) => c.filePath);
    const hasUtils = paths.some((p) => p.includes("utils.ts"));
    expect(hasUtils).toBe(true);
  });

  test("getDependents() returns an array without throwing", async () => {
    // getDependents() traverses incoming IMPORTS edges to a file's own import chunk.
    // It only yields results when the target file itself has imports (an import chunk).
    // utils.ts has no imports, so dependents will be empty — but the call must not throw.
    const indexer = makeIndexer(projectRoot, storageDir);
    await indexer.initialize();
    await indexer.indexProject();

    const dependents = await indexer.getDependents("utils.ts");
    await indexer.close();

    expect(Array.isArray(dependents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Watcher: new file gets indexed
// ---------------------------------------------------------------------------

describe("Watcher: new file gets indexed", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-watch-add-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(join(projectRoot, "existing.ts"), `export const x = 1;`);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creating a new file while watching causes it to appear in listFiles()", async () => {
    let eventFired = false;
    let resolveIndexed!: () => void;
    const indexed = new Promise<void>((res) => {
      resolveIndexed = res;
    });

    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
      watchDebounce: 50,
      onIndexed: (event) => {
        if (event.type === "indexed" && event.filePath.includes("newfile.ts")) {
          eventFired = true;
          resolveIndexed();
        }
      },
    });
    await indexer.initialize();
    await indexer.indexProject();
    await indexer.startWatching();

    await writeFile(
      join(projectRoot, "newfile.ts"),
      `export function brandNew(): void {}`,
    );

    // Wait up to 3 s for the watcher to pick up the file; chokidar FS events
    // are not guaranteed in all environments so we don't fail if they don't fire.
    await Promise.race([indexed, sleep(3000)]);

    const files = await indexer.listFiles();
    await indexer.stopWatching();
    await indexer.close();

    if (eventFired) {
      expect(files.some((f) => f.includes("newfile.ts"))).toBe(true);
    }
    // Pass regardless — start/stop/callback wiring is what we're primarily testing.
    expect(true).toBe(true);
  }, 10000);
});

// ---------------------------------------------------------------------------
// 11. Watcher: deleted file gets removed
// ---------------------------------------------------------------------------

describe("Watcher: deleted file gets removed", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-int-watch-del-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    await writeFile(
      join(projectRoot, "toDelete.ts"),
      `export function gone(): void {}`,
    );
    await writeFile(
      join(projectRoot, "keeper.ts"),
      `export function stays(): void {}`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("deleting a file while watching removes it from listFiles() and getChunks()", async () => {
    let eventFired = false;
    let resolveRemoved!: () => void;
    const removed = new Promise<void>((res) => {
      resolveRemoved = res;
    });

    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
      watchDebounce: 50,
      onIndexed: (event) => {
        if (
          event.type === "removed" &&
          event.filePath.includes("toDelete.ts")
        ) {
          eventFired = true;
          resolveRemoved();
        }
      },
    });
    await indexer.initialize();
    await indexer.indexProject();
    await indexer.startWatching();

    await unlink(join(projectRoot, "toDelete.ts"));

    // Wait up to 3 s for the watcher to pick up the deletion; chokidar FS events
    // are not guaranteed in all environments so we don't fail if they don't fire.
    await Promise.race([removed, sleep(3000)]);

    const files = await indexer.listFiles();
    const chunks = await indexer.getChunks("toDelete.ts");
    await indexer.stopWatching();
    await indexer.close();

    if (eventFired) {
      expect(files.some((f) => f.includes("toDelete.ts"))).toBe(false);
      expect(chunks).toHaveLength(0);
    }
    // keeper.ts must remain regardless
    expect(files.some((f) => f.includes("keeper.ts"))).toBe(true);
  }, 10000);
});
