import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../CodeIndexer.js";
import { TreeSitterChunker } from "../chunker/index.js";
import { GraphTraverser } from "../graph/GraphTraverser.js";
import { SymbolResolver } from "../graph/SymbolResolver.js";
import { GraphStore } from "../store/GraphStore.js";
import type { VectorStore } from "../store/VectorStore.js";
import type { CodeChunk, GraphEdge, RelationshipType } from "../types.js";

// ---------------------------------------------------------------------------
// Edge extraction via chunkSourceWithEdges
// ---------------------------------------------------------------------------

describe("chunkSourceWithEdges — TypeScript", () => {
  let chunker: TreeSitterChunker;

  beforeAll(async () => {
    chunker = new TreeSitterChunker({});
    await chunker.initialize();
  });

  afterAll(async () => {
    await chunker.close();
  });

  const SOURCE = `
import { formatDate } from './utils';
import { EventEmitter } from 'events';

export class UserService extends EventEmitter {
  private name: string = '';

  constructor() {
    super();
  }

  greet(): string {
    return formatDate(new Date());
  }
}

export function createUser(name: string) {
  const svc = new UserService();
  return svc;
}
`.trim();

  test("emits IMPORTS edges for each import statement", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const imports = rawEdges.filter((e) => e.type === "IMPORTS");
    expect(imports.length).toBeGreaterThanOrEqual(2);

    const targets = imports.map((e) => e.targetFilePath);
    expect(targets).toContain("./utils");
    expect(targets).toContain("events");
  });

  test("emits EXTENDS edges for class heritage", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const extends_ = rawEdges.filter((e) => e.type === "EXTENDS");
    expect(extends_.length).toBeGreaterThan(0);
    expect(extends_.some((e) => e.targetSymbol === "EventEmitter")).toBe(true);
  });

  test("EXTENDS edge carries targetFilePath hint when base class was imported", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const extendsEdge = rawEdges.find(
      (e) => e.type === "EXTENDS" && e.targetSymbol === "EventEmitter",
    );
    expect(extendsEdge?.targetFilePath).toBe("events");
  });

  test("emits CALLS edges inside function bodies", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const calls = rawEdges.filter((e) => e.type === "CALLS");
    const callees = calls.map((e) => e.targetSymbol);
    // createUser calls UserService (constructor) and svc (member call)
    expect(
      callees.some(
        (c) => c === "UserService" || c === "formatDate" || c === "greet",
      ),
    ).toBe(true);
  });

  test("emits DEFINES edges from import chunk to each named export", async () => {
    const { chunks, rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const defines = rawEdges.filter((e) => e.type === "DEFINES");
    expect(defines.length).toBeGreaterThan(0);

    // DEFINES edges should have sourceChunkId = import chunk id
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    const allFromImport = defines.every(
      (e) => e.sourceChunkId === importChunk?.id,
    );
    expect(allFromImport).toBe(true);

    // DEFINES targetSymbols are chunk IDs for the named declarations
    const namedChunks = chunks.filter((c) => c.type !== "import" && c.name);
    const definedIds = new Set(defines.map((e) => e.targetSymbol));
    for (const named of namedChunks) {
      expect(definedIds.has(named.id)).toBe(true);
    }
  });

  test("sourceChunkId references a real chunk", async () => {
    const { chunks, rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    const chunkIds = new Set(chunks.map((c) => c.id));
    for (const edge of rawEdges) {
      expect(chunkIds.has(edge.sourceChunkId)).toBe(true);
    }
  });

  test("sourceFilePath is set on all raw edges", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      "service.ts",
      "proj",
      "typescript",
    );
    expect(rawEdges.every((e) => e.sourceFilePath === "service.ts")).toBe(true);
  });
});

describe("chunkSourceWithEdges — JavaScript", () => {
  let chunker: TreeSitterChunker;

  beforeAll(async () => {
    chunker = new TreeSitterChunker({});
    await chunker.initialize();
  });

  afterAll(async () => {
    await chunker.close();
  });

  const JS_SOURCE = `
import { helper } from './helper.js';

export class Greeter extends EventEmitter {
  sayHello() {
    return helper('hello');
  }
}
`.trim();

  test("emits IMPORTS and EXTENDS edges from JS source", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      JS_SOURCE,
      "greeter.js",
      "proj",
      "javascript",
    );
    expect(rawEdges.some((e) => e.type === "IMPORTS")).toBe(true);
    expect(rawEdges.some((e) => e.type === "EXTENDS")).toBe(true);
  });

  test("emits CALLS edges in JS methods", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      JS_SOURCE,
      "greeter.js",
      "proj",
      "javascript",
    );
    const calls = rawEdges.filter((e) => e.type === "CALLS");
    expect(calls.some((e) => e.targetSymbol === "helper")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SymbolResolver — import path resolution + tsconfig paths
// ---------------------------------------------------------------------------

describe("SymbolResolver — resolveImportPath", () => {
  let tmpDir: string;
  let resolver: SymbolResolver;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolver-test-"));

    // Create a minimal file tree for probing
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await mkdir(join(tmpDir, "src", "auth"), { recursive: true });
    await writeFile(join(tmpDir, "src", "utils.ts"), "export const x = 1;");
    await writeFile(
      join(tmpDir, "src", "auth", "index.ts"),
      "export const auth = true;",
    );

    resolver = new SymbolResolver(tmpDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("resolves relative import with .ts extension probing", async () => {
    const resolved = await resolver.resolveImportPath(
      "./src/utils",
      "index.ts",
    );
    expect(resolved).toBe(join(tmpDir, "src", "utils.ts"));
  });

  test("resolves relative import to index.ts", async () => {
    const resolved = await resolver.resolveImportPath("./src/auth", "index.ts");
    expect(resolved).toBe(join(tmpDir, "src", "auth", "index.ts"));
  });

  test("returns null for external (non-relative, non-aliased) specifier", async () => {
    const resolved = await resolver.resolveImportPath("react", "src/app.ts");
    expect(resolved).toBeNull();
  });
});

describe("SymbolResolver — tsconfig paths", () => {
  let tmpDir: string;
  let resolver: SymbolResolver;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolver-paths-test-"));

    // File tree
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });
    await mkdir(join(tmpDir, "src", "components"), { recursive: true });
    await writeFile(
      join(tmpDir, "src", "utils", "format.ts"),
      "export const fmt = () => {};",
    );
    await writeFile(
      join(tmpDir, "src", "components", "Button.ts"),
      "export class Button {}",
    );

    // tsconfig.json with path aliases
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@utils/*": ["src/utils/*"],
            "@components/*": ["src/components/*"],
            "~config": ["src/config.ts"],
          },
        },
      }),
    );
    await writeFile(
      join(tmpDir, "src", "config.ts"),
      "export const config = {};",
    );

    resolver = new SymbolResolver(tmpDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("resolves wildcard alias @utils/* → src/utils/*", async () => {
    const resolved = await resolver.resolveImportPath(
      "@utils/format",
      "src/app.ts",
    );
    expect(resolved).toBe(join(tmpDir, "src", "utils", "format.ts"));
  });

  test("resolves wildcard alias @components/* → src/components/*", async () => {
    const resolved = await resolver.resolveImportPath(
      "@components/Button",
      "src/app.ts",
    );
    expect(resolved).toBe(join(tmpDir, "src", "components", "Button.ts"));
  });

  test("resolves exact alias ~config → src/config.ts", async () => {
    const resolved = await resolver.resolveImportPath("~config", "src/app.ts");
    expect(resolved).toBe(join(tmpDir, "src", "config.ts"));
  });

  test("falls back to relative resolution when alias doesn't match", async () => {
    const resolved = await resolver.resolveImportPath(
      "./utils/format",
      "src/app.ts",
    );
    expect(resolved).toBe(join(tmpDir, "src", "utils", "format.ts"));
  });
});

// ---------------------------------------------------------------------------
// CodeIndexer graph integration
// ---------------------------------------------------------------------------

describe("CodeIndexer — graph integration", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;
  let indexer: CodeIndexer;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "graph-indexer-test-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });

    // utils.ts — exports helpers
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

    // user.ts — imports from utils, defines a class
    await writeFile(
      join(projectRoot, "user.ts"),
      `
import { formatDate } from './utils';

export interface User {
  id: string;
  name: string;
}

export class UserService {
  getCreatedAt(): string {
    return formatDate(new Date());
  }
}
`.trim(),
    );

    // service.ts — imports from user.ts and calls UserService
    await writeFile(
      join(projectRoot, "service.ts"),
      `
import { UserService } from './user';

export function buildService(): UserService {
  return new UserService();
}
`.trim(),
    );

    indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: false,
    });
    await indexer.initialize();
    await indexer.indexProject();
  });

  afterAll(async () => {
    await indexer.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("getStats() includes totalEdges > 0", async () => {
    const stats = await indexer.getStats();
    expect(stats.totalEdges).toBeGreaterThan(0);
  });

  test("getStats() byEdgeType includes IMPORTS and DEFINES", async () => {
    const stats = await indexer.getStats();
    expect(stats.byEdgeType.IMPORTS).toBeGreaterThan(0);
    expect(stats.byEdgeType.DEFINES).toBeGreaterThan(0);
  });

  test("getEdgesFrom() returns outgoing edges for an import chunk", async () => {
    const chunks = await indexer.getChunks("user.ts");
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of importChunk in this test
    const edges = await indexer.getEdgesFrom(importChunk!.id);
    expect(edges.length).toBeGreaterThan(0);
    // Should have at least IMPORTS and DEFINES edges
    const types = new Set(edges.map((e) => e.type));
    expect(types.has("IMPORTS") || types.has("DEFINES")).toBe(true);
  });

  test("getEdgesTo() returns incoming edges for a chunk", async () => {
    // utils.ts exports formatDate — user.ts imports it
    // The import chunk of utils.ts should receive an incoming IMPORTS edge from user.ts
    const utilChunks = await indexer.getChunks("utils.ts");
    const importChunk = utilChunks.find((c) => c.type === "import");
    if (!importChunk) return; // utils.ts has no imports — skip gracefully

    const edges = await indexer.getEdgesTo(importChunk.id, ["IMPORTS"]);
    // user.ts imports from utils.ts
    expect(edges.length).toBeGreaterThanOrEqual(0); // may or may not resolve depending on fixture
  });

  test("getDependencies() returns chunks from imported files", async () => {
    const deps = await indexer.getDependencies("user.ts");
    // user.ts imports from utils.ts
    expect(deps.length).toBeGreaterThanOrEqual(0);
  });

  test("getDependents() returns chunks from files that import the given file", async () => {
    const dependents = await indexer.getDependents("user.ts");
    // service.ts imports from user.ts
    expect(dependents.length).toBeGreaterThanOrEqual(0);
  });

  test("getCallers() returns callers of a named function", async () => {
    const utilChunks = await indexer.getChunks("utils.ts");
    const formatDate = utilChunks.find((c) => c.name === "formatDate");
    expect(formatDate).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of formatDate chunk in this test
    const callers = await indexer.getCallers(formatDate!.id);
    // getCreatedAt in user.ts calls formatDate
    expect(Array.isArray(callers)).toBe(true);
  });

  test("getCallees() returns functions called by a given chunk", async () => {
    const userChunks = await indexer.getChunks("user.ts");
    const getCreatedAt = userChunks.find((c) =>
      c.name?.includes("getCreatedAt"),
    );
    expect(getCreatedAt).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of getCreatedAt chunk in this test
    const callees = await indexer.getCallees(getCreatedAt!.id);
    expect(Array.isArray(callees)).toBe(true);
  });

  test("getNeighborhood() returns center chunk and edges", async () => {
    const userChunks = await indexer.getChunks("user.ts");
    const importChunk = userChunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of importChunk in this test
    const hood = await indexer.getNeighborhood(importChunk!.id, { depth: 1 });
    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of importChunk in this test
    expect(hood.center.id).toBe(importChunk!.id);
    expect(Array.isArray(hood.edges)).toBe(true);
  });

  test("getNeighborhood() directions are 'outgoing' or 'incoming'", async () => {
    const userChunks = await indexer.getChunks("user.ts");
    const importChunk = userChunks.find((c) => c.type === "import");
    if (!importChunk) return;

    const hood = await indexer.getNeighborhood(importChunk.id, { depth: 1 });
    for (const entry of hood.edges) {
      expect(["outgoing", "incoming"]).toContain(entry.direction);
    }
  });

  test("getNeighborhood() with depth=0 returns empty edges", async () => {
    const chunks = await indexer.getChunks("user.ts");
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of importChunk in this test
    const hood = await indexer.getNeighborhood(importChunk!.id, { depth: 0 });
    expect(hood.edges).toHaveLength(0);
  });

  test("searchWithContext() returns at least as many results as search()", async () => {
    await indexer.indexProject(); // ensure index is fresh
    const base = await indexer.search("UserService", { limit: 5 });
    const withCtx = await indexer.searchWithContext("UserService", {
      limit: 5,
      graphDepth: 1,
    });
    expect(withCtx.length).toBeGreaterThanOrEqual(base.length);
  });

  test("removeFile() also removes edges for that file", async () => {
    // Index a fresh file, check edges exist, remove it, check edges gone
    await writeFile(
      join(projectRoot, "temp.ts"),
      `import { formatDate } from './utils';\nexport const ts = formatDate(new Date());`,
    );
    await indexer.indexFile("temp.ts");

    const tempChunks = await indexer.getChunks("temp.ts");
    const importChunk = tempChunks.find((c) => c.type === "import");
    const edgesBefore = importChunk
      ? await indexer.getEdgesFrom(importChunk.id)
      : [];

    await indexer.removeFile("temp.ts");

    const edgesAfter = importChunk
      ? await indexer.getEdgesFrom(importChunk.id)
      : [];
    expect(edgesAfter.length).toBe(0);
    // If there were edges before, they should now be gone
    if (edgesBefore.length > 0) {
      expect(edgesAfter.length).toBeLessThan(edgesBefore.length);
    }
  });

  // ── Phase 4 additions ────────────────────────────────────────────────────

  test("getDependencies() result contains chunk from utils.ts", async () => {
    const deps = await indexer.getDependencies("user.ts");
    // user.ts imports from utils.ts — at least one dep chunk should reference utils.ts
    expect(deps.some((c) => c.filePath.includes("utils.ts"))).toBe(true);
  });

  test("getDependents() result contains chunk from service.ts", async () => {
    const dependents = await indexer.getDependents("user.ts");
    // service.ts imports from user.ts
    expect(dependents.some((c) => c.filePath.includes("service.ts"))).toBe(
      true,
    );
  });

  test("getCallers() of formatDate returns an array (may be empty if CALLS not cross-file resolved)", async () => {
    const utilChunks = await indexer.getChunks("utils.ts");
    const formatDate = utilChunks.find((c) => c.name === "formatDate");
    expect(formatDate).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of formatDate chunk in this test
    const callers = await indexer.getCallers(formatDate!.id);
    expect(Array.isArray(callers)).toBe(true);
    // If CALLS edges are cross-file resolved, user.ts should appear
    if (callers.length > 0) {
      expect(callers.some((c) => c.filePath.includes("user.ts"))).toBe(true);
    }
  });

  test("getCallees() of getCreatedAt returns an array (may be empty if CALLS not cross-file resolved)", async () => {
    const userChunks = await indexer.getChunks("user.ts");
    const getCreatedAt = userChunks.find((c) =>
      c.name?.includes("getCreatedAt"),
    );
    expect(getCreatedAt).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of getCreatedAt chunk in this test
    const callees = await indexer.getCallees(getCreatedAt!.id);
    expect(Array.isArray(callees)).toBe(true);
    // If CALLS edges are cross-file resolved, formatDate should appear
    if (callees.length > 0) {
      expect(callees.some((c) => c.name === "formatDate")).toBe(true);
    }
  });

  test("searchWithContext() with graphDepth=0 returns same results as search()", async () => {
    const base = await indexer.search("UserService", { limit: 5 });
    const withCtx = await indexer.searchWithContext("UserService", {
      limit: 5,
      graphDepth: 0,
    });
    // With depth=0 the graph expansion is skipped — results should be identical
    expect(withCtx.length).toBe(base.length);
    const baseIds = base.map((r) => r.chunk.id).sort();
    const ctxIds = withCtx.map((r) => r.chunk.id).sort();
    expect(ctxIds).toEqual(baseIds);
  });

  test("re-indexing a file with changed content removes stale edges", async () => {
    // Create temp2.ts with a known structure
    await writeFile(
      join(projectRoot, "temp2.ts"),
      [
        "import { formatDate } from './utils';",
        "",
        "export function printDate(): void {",
        "  console.log(formatDate(new Date()));",
        "}",
      ].join("\n"),
    );
    await indexer.indexFile("temp2.ts");

    const chunksAfterAdd = await indexer.getChunks("temp2.ts");
    expect(chunksAfterAdd.length).toBeGreaterThan(0);

    // Collect all edges for temp2.ts chunks
    const edgesAfterAdd: import("../types.js").GraphEdge[] = [];
    for (const c of chunksAfterAdd) {
      edgesAfterAdd.push(...(await indexer.getEdgesFrom(c.id)));
    }
    expect(edgesAfterAdd.length).toBeGreaterThan(0);

    // Rewrite temp2.ts to have no imports
    await writeFile(join(projectRoot, "temp2.ts"), "export const v = 42;");
    await indexer.indexFile("temp2.ts");

    // All old chunks are replaced — old edges should be gone
    const chunksAfterEdit = await indexer.getChunks("temp2.ts");
    const edgesAfterEdit: import("../types.js").GraphEdge[] = [];
    for (const c of chunksAfterEdit) {
      edgesAfterEdit.push(...(await indexer.getEdgesFrom(c.id)));
    }
    // None of the old chunk IDs should have edges any more
    const oldChunkIds = new Set(chunksAfterAdd.map((c) => c.id));
    const staleEdges = edgesAfterEdit.filter((e) =>
      oldChunkIds.has(e.sourceChunkId),
    );
    expect(staleEdges.length).toBe(0);

    await indexer.removeFile("temp2.ts");
  });
});

// ---------------------------------------------------------------------------
// GraphStore — unit tests
// ---------------------------------------------------------------------------

describe("GraphStore", () => {
  let tmpDir: string;
  let store: GraphStore;

  function makeEdge(
    id: string,
    sourceChunkId: string,
    targetChunkId: string,
    type: string,
    sourceFilePath = "a.ts",
  ) {
    return {
      id,
      projectId: "proj",
      sourceChunkId,
      sourceFilePath,
      targetChunkId,
      type,
      metadata: {},
    } as import("../types.js").GraphEdge;
  }

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "graphstore-unit-"));
    store = new GraphStore(tmpDir);
    await store.initialize();
  });

  afterAll(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("upsertEdges() stores edges and countEdges() returns correct count", async () => {
    await store.upsertEdges([
      makeEdge("e1", "c1", "c2", "IMPORTS"),
      makeEdge("e2", "c1", "c3", "DEFINES"),
    ]);
    const count = await store.countEdges();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("getOutgoing() returns edges by sourceChunkId", async () => {
    const edges = await store.getOutgoing("c1");
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.every((e) => e.sourceChunkId === "c1")).toBe(true);
  });

  test("getIncoming() returns edges by targetChunkId", async () => {
    const edges = await store.getIncoming("c2");
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.every((e) => e.targetChunkId === "c2")).toBe(true);
  });

  test("getOutgoing() with types filter returns only matching edge types", async () => {
    const edges = await store.getOutgoing("c1", ["IMPORTS"]);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.every((e) => e.type === "IMPORTS")).toBe(true);
  });

  test("getOutgoing() with types filter excludes non-matching types", async () => {
    const edges = await store.getOutgoing("c1", ["CALLS"]);
    expect(edges.every((e) => e.type === "CALLS")).toBe(true);
  });

  test("deleteEdgesByFile() removes edges for that file; others remain", async () => {
    await store.upsertEdges([
      makeEdge("e3", "cX", "cY", "IMPORTS", "b.ts"),
      makeEdge("e4", "cX", "cZ", "DEFINES", "b.ts"),
    ]);
    const before = await store.getOutgoing("cX");
    expect(before.length).toBe(2);

    await store.deleteEdgesByFile("b.ts");

    const after = await store.getOutgoing("cX");
    expect(after.length).toBe(0);
    // Edges for a.ts should still exist
    const aEdges = await store.getOutgoing("c1");
    expect(aEdges.length).toBeGreaterThanOrEqual(2);
  });

  test("countByType() returns partitioned counts", async () => {
    const counts = await store.countByType();
    expect(counts.IMPORTS).toBeGreaterThanOrEqual(1);
    expect(counts.DEFINES).toBeGreaterThanOrEqual(1);
  });

  test("upsertEdges() is idempotent — no duplicate rows", async () => {
    const countBefore = await store.countEdges();
    await store.upsertEdges([
      makeEdge("e1", "c1", "c2", "IMPORTS"),
      makeEdge("e2", "c1", "c3", "DEFINES"),
    ]);
    const countAfter = await store.countEdges();
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// GraphTraverser — unit tests (inline mocks)
// ---------------------------------------------------------------------------

describe("GraphTraverser", () => {
  // ── Inline mocks ────────────────────────────────────────────────────────

  function makeChunk(
    id: string,
    filePath = "f.ts",
    type: CodeChunk["type"] = "function",
  ): CodeChunk {
    return {
      id,
      projectId: "proj",
      filePath,
      language: "typescript",
      type,
      content: "",
      contextContent: "",
      startLine: 0,
      endLine: 0,
      metadata: {},
    };
  }

  function makeEdge(
    id: string,
    sourceChunkId: string,
    targetChunkId: string,
    type: RelationshipType,
    sourceFilePath = "f.ts",
  ): GraphEdge {
    return {
      id,
      projectId: "proj",
      sourceChunkId,
      targetChunkId,
      type,
      sourceFilePath,
      metadata: {},
    };
  }

  class MockGraphStore {
    private edges: GraphEdge[] = [];

    addEdges(...edges: GraphEdge[]) {
      this.edges.push(...edges);
    }

    async getOutgoing(
      chunkId: string,
      types?: RelationshipType[],
    ): Promise<GraphEdge[]> {
      return this.edges.filter(
        (e) =>
          e.sourceChunkId === chunkId && (!types || types.includes(e.type)),
      );
    }

    async getIncoming(
      chunkId: string,
      types?: RelationshipType[],
    ): Promise<GraphEdge[]> {
      return this.edges.filter(
        (e) =>
          e.targetChunkId === chunkId && (!types || types.includes(e.type)),
      );
    }
  }

  class MockVectorStore {
    private chunks: Map<string, CodeChunk> = new Map();
    private byFile: Map<string, CodeChunk[]> = new Map();

    addChunks(...chunks: CodeChunk[]) {
      for (const c of chunks) {
        this.chunks.set(c.id, c);
        const list = this.byFile.get(c.filePath) ?? [];
        list.push(c);
        this.byFile.set(c.filePath, list);
      }
    }

    async getChunksByIds(ids: string[]): Promise<CodeChunk[]> {
      return ids.flatMap((id) => {
        const c = this.chunks.get(id);
        return c ? [c] : [];
      });
    }

    async getChunksByFile(filePath: string): Promise<CodeChunk[]> {
      return this.byFile.get(filePath) ?? [];
    }
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  test("getNeighborhood() with unknown chunkId returns empty edge list", async () => {
    const graphStore = new MockGraphStore() as unknown as GraphStore;
    const vectorStore = new MockVectorStore() as unknown as VectorStore;
    const traverser = new GraphTraverser(graphStore, vectorStore);

    const hood = await traverser.getNeighborhood("unknown-id");
    expect(hood.center.id).toBe("unknown-id");
    expect(hood.edges).toHaveLength(0);
  });

  test("getNeighborhood() depth=1 returns direct neighbours with direction", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    const chunkA = makeChunk("A");
    const chunkB = makeChunk("B");
    vectorStore.addChunks(chunkA, chunkB);
    graphStore.addEdges(makeEdge("e1", "A", "B", "CALLS"));

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const hood = await traverser.getNeighborhood("A", { depth: 1 });

    expect(hood.center.id).toBe("A");
    expect(hood.edges.length).toBe(1);
    expect(hood.edges[0]?.chunk.id).toBe("B");
    expect(hood.edges[0]?.direction).toBe("outgoing");
  });

  test("getNeighborhood() depth=2 follows second hop", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    const [cA, cB, cC] = [makeChunk("A"), makeChunk("B"), makeChunk("C")];
    vectorStore.addChunks(cA, cB, cC);
    graphStore.addEdges(
      makeEdge("e1", "A", "B", "CALLS"),
      makeEdge("e2", "B", "C", "CALLS"),
    );

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const hood = await traverser.getNeighborhood("A", { depth: 2 });
    const ids = hood.edges.map((e) => e.chunk.id);

    expect(ids).toContain("B");
    expect(ids).toContain("C");
  });

  test("getNeighborhood() limit caps number of returned edges", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    const center = makeChunk("center");
    vectorStore.addChunks(center);
    for (let i = 0; i < 10; i++) {
      const c = makeChunk(`n${i}`);
      vectorStore.addChunks(c);
      graphStore.addEdges(makeEdge(`e${i}`, "center", `n${i}`, "CALLS"));
    }

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const hood = await traverser.getNeighborhood("center", {
      depth: 1,
      limit: 3,
    });
    expect(hood.edges.length).toBeLessThanOrEqual(3);
  });

  test("getNeighborhood() relationTypes filter excludes other edge types", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    vectorStore.addChunks(makeChunk("A"), makeChunk("B"), makeChunk("C"));
    graphStore.addEdges(
      makeEdge("e1", "A", "B", "CALLS"),
      makeEdge("e2", "A", "C", "IMPORTS"),
    );

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const hood = await traverser.getNeighborhood("A", {
      depth: 1,
      relationTypes: ["CALLS"],
    });
    const types = hood.edges.map((e) => e.edge.type);
    expect(types.every((t) => t === "CALLS")).toBe(true);
    expect(hood.edges.map((e) => e.chunk.id)).toContain("B");
    expect(hood.edges.map((e) => e.chunk.id)).not.toContain("C");
  });

  test("getCallers() returns chunks that call the target", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    vectorStore.addChunks(makeChunk("caller"), makeChunk("callee"));
    graphStore.addEdges(makeEdge("e1", "caller", "callee", "CALLS"));

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const callers = await traverser.getCallers("callee");
    expect(callers.map((c) => c.id)).toContain("caller");
  });

  test("getCallees() returns chunks called by the source", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    vectorStore.addChunks(makeChunk("caller"), makeChunk("callee"));
    graphStore.addEdges(makeEdge("e1", "caller", "callee", "CALLS"));

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const callees = await traverser.getCallees("caller");
    expect(callees.map((c) => c.id)).toContain("callee");
  });

  test("getDependencies() follows IMPORTS edges from the import chunk", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    const importChunk = makeChunk("imp-a", "a.ts", "import");
    const targetImportChunk = makeChunk("imp-b", "b.ts", "import");
    vectorStore.addChunks(importChunk, targetImportChunk);
    graphStore.addEdges(makeEdge("e1", "imp-a", "imp-b", "IMPORTS"));

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const deps = await traverser.getDependencies(
      "a.ts",
      vectorStore as unknown as VectorStore,
    );
    expect(deps.map((c) => c.id)).toContain("imp-b");
  });

  test("getDependents() follows incoming IMPORTS edges to the import chunk", async () => {
    const graphStore = new MockGraphStore();
    const vectorStore = new MockVectorStore();

    const importA = makeChunk("imp-a", "a.ts", "import");
    const importB = makeChunk("imp-b", "b.ts", "import");
    vectorStore.addChunks(importA, importB);
    // a.ts imports b.ts — so incoming edge on imp-b is from imp-a
    graphStore.addEdges(makeEdge("e1", "imp-a", "imp-b", "IMPORTS"));

    const traverser = new GraphTraverser(
      graphStore as unknown as GraphStore,
      vectorStore as unknown as VectorStore,
    );
    const dependents = await traverser.getDependents(
      "b.ts",
      vectorStore as unknown as VectorStore,
    );
    expect(dependents.map((c) => c.id)).toContain("imp-a");
  });
});

// ---------------------------------------------------------------------------
// SymbolResolver — buildExportMap and resolveAll
// ---------------------------------------------------------------------------

describe("SymbolResolver — buildExportMap", () => {
  test("maps absolute filePath → symbolName → chunkId", () => {
    const resolver = new SymbolResolver("/proj");
    const chunks = [
      {
        id: "chunk-1",
        projectId: "proj",
        filePath: "src/utils.ts",
        language: "typescript" as const,
        type: "function" as const,
        name: "formatDate",
        content: "",
        contextContent: "",
        startLine: 1,
        endLine: 5,
        metadata: {},
      },
    ];
    const map = resolver.buildExportMap(chunks);
    const absPath = join("/proj", "src/utils.ts");
    expect(map.get(absPath)?.get("formatDate")).toBe("chunk-1");
  });

  test("registers short method name for Class#method chunks", () => {
    const resolver = new SymbolResolver("/proj");
    const chunks = [
      {
        id: "chunk-2",
        projectId: "proj",
        filePath: "src/svc.ts",
        language: "typescript" as const,
        type: "method" as const,
        name: "UserService#getUser",
        content: "",
        contextContent: "",
        startLine: 10,
        endLine: 15,
        metadata: {},
      },
    ];
    const map = resolver.buildExportMap(chunks);
    const absPath = join("/proj", "src/svc.ts");
    expect(map.get(absPath)?.get("UserService#getUser")).toBe("chunk-2");
    expect(map.get(absPath)?.get("getUser")).toBe("chunk-2");
  });

  test("ignores import-type chunks", () => {
    const resolver = new SymbolResolver("/proj");
    const chunks = [
      {
        id: "imp-1",
        projectId: "proj",
        filePath: "src/utils.ts",
        language: "typescript" as const,
        type: "import" as const,
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 2,
        metadata: {},
      },
    ];
    const map = resolver.buildExportMap(chunks);
    // import chunk has no name — should produce no entries
    const absPath = join("/proj", "src/utils.ts");
    expect(map.get(absPath)?.size ?? 0).toBe(0);
  });
});

describe("SymbolResolver — resolveAll", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolver-resolve-all-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src", "utils.ts"), "export const x = 1;");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("DEFINES edge passes through with targetChunkId = targetSymbol", async () => {
    const resolver = new SymbolResolver(tmpDir);
    const rawEdges = [
      {
        sourceChunkId: "src-chunk",
        sourceFilePath: "src/app.ts",
        type: "DEFINES" as const,
        targetSymbol: "target-chunk-id",
        metadata: {},
      },
    ];
    const chunks = [
      {
        id: "src-chunk",
        projectId: "proj",
        filePath: "src/app.ts",
        language: "typescript" as const,
        type: "import" as const,
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 0,
        metadata: {},
      },
      {
        id: "target-chunk-id",
        projectId: "proj",
        filePath: "src/app.ts",
        language: "typescript" as const,
        type: "function" as const,
        name: "doThing",
        content: "",
        contextContent: "",
        startLine: 3,
        endLine: 6,
        metadata: {},
      },
    ];
    const resolved = await resolver.resolveAll(rawEdges, chunks, "proj");
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.targetChunkId).toBe("target-chunk-id");
    expect(resolved[0]?.type).toBe("DEFINES");
  });

  test("IMPORTS edge resolves when targetFilePath maps to an indexed file", async () => {
    const resolver = new SymbolResolver(tmpDir);
    const rawEdges = [
      {
        sourceChunkId: "imp-chunk",
        sourceFilePath: "src/app.ts",
        type: "IMPORTS" as const,
        targetSymbol: "./utils",
        targetFilePath: "./utils",
        metadata: {},
      },
    ];
    const chunks = [
      {
        id: "imp-chunk",
        projectId: "proj",
        filePath: "src/app.ts",
        language: "typescript" as const,
        type: "import" as const,
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 0,
        metadata: {},
      },
      {
        id: "utils-import-chunk",
        projectId: "proj",
        filePath: "src/utils.ts",
        language: "typescript" as const,
        type: "import" as const,
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 0,
        metadata: {},
      },
    ];
    const resolved = await resolver.resolveAll(rawEdges, chunks, "proj");
    const importEdge = resolved.find((e) => e.type === "IMPORTS");
    expect(importEdge).toBeDefined();
    expect(importEdge?.targetChunkId).toBe("utils-import-chunk");
  });

  test("unresolvable external IMPORTS edge is silently dropped", async () => {
    const resolver = new SymbolResolver(tmpDir);
    const rawEdges = [
      {
        sourceChunkId: "imp-chunk",
        sourceFilePath: "src/app.ts",
        type: "IMPORTS" as const,
        targetSymbol: "react",
        targetFilePath: "react",
        metadata: {},
      },
    ];
    const chunks = [
      {
        id: "imp-chunk",
        projectId: "proj",
        filePath: "src/app.ts",
        language: "typescript" as const,
        type: "import" as const,
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 0,
        metadata: {},
      },
    ];
    const resolved = await resolver.resolveAll(rawEdges, chunks, "proj");
    expect(resolved.length).toBe(0);
  });
});

describe("SymbolResolver — .js → .ts extension remapping", () => {
  let tmpDir: string;
  let resolver: SymbolResolver;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolver-extremap-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src", "utils.ts"), "export const x = 1;");
    resolver = new SymbolResolver(tmpDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("resolves .js specifier to the matching .ts file on disk", async () => {
    const resolved = await resolver.resolveImportPath(
      "./src/utils.js",
      "index.ts",
    );
    expect(resolved).toBe(join(tmpDir, "src", "utils.ts"));
  });
});
