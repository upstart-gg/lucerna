import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CodeIndexer } from "../CodeIndexer.js";
import { createMcpServer } from "../mcp/server.js";
import type { GraphNeighborhood, SearchResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface IndexerStub {
  search: (q: string) => Promise<SearchResult[]>;
  searchWithContext: (q: string) => Promise<SearchResult[]>;
  getNeighborhood: (id: string) => Promise<GraphNeighborhood>;
}

/** Minimal stub that satisfies the three methods the MCP server calls. */
function makeIndexer(overrides: Partial<IndexerStub> = {}): CodeIndexer {
  const stub: IndexerStub = {
    search: async (_q: string): Promise<SearchResult[]> => [],
    searchWithContext: async (_q: string): Promise<SearchResult[]> => [],
    getNeighborhood: async (_id: string): Promise<GraphNeighborhood> => ({
      center: null as unknown as GraphNeighborhood["center"],
      edges: [],
    }),
  };
  return { ...stub, ...overrides } as unknown as CodeIndexer;
}

interface TestHarness {
  client: Client;
  cleanup: () => Promise<void>;
}

/** Extracts and parses the JSON payload from a callTool text response. */
function parseToolPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  if (!content[0]) throw new Error("callTool returned empty content");
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

async function makeHarness(
  indexer: CodeIndexer,
  indexingComplete = true,
): Promise<TestHarness> {
  const server = createMcpServer(indexer, () => indexingComplete);
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.cleanup();
  });

  test("lists search_codebase and get_neighbors", async () => {
    harness = await makeHarness(makeIndexer());
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_codebase");
    expect(names).toContain("get_neighbors");
  });

  test("search_codebase has required query input", async () => {
    harness = await makeHarness(makeIndexer());
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === "search_codebase");
    expect(tool?.inputSchema.required).toContain("query");
  });

  test("get_neighbors has required chunkId input", async () => {
    harness = await makeHarness(makeIndexer());
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === "get_neighbors");
    expect(tool?.inputSchema.required).toContain("chunkId");
  });
});

// ---------------------------------------------------------------------------
// search_codebase — warning field
// ---------------------------------------------------------------------------

describe("search_codebase warning", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.cleanup();
  });

  test("includes warning when indexing is not yet complete", async () => {
    harness = await makeHarness(makeIndexer(), false);
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "hello" },
    });
    const payload = parseToolPayload(result);
    expect(payload.warning).toBeString();
    expect(payload.warning).toInclude("initializing");
  });

  test("omits warning when indexing is complete", async () => {
    harness = await makeHarness(makeIndexer(), true);
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "hello" },
    });
    const payload = parseToolPayload(result);
    expect(payload.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search_codebase — search delegation
// ---------------------------------------------------------------------------

describe("search_codebase delegation", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.cleanup();
  });

  test("calls searchWithContext when includeGraphContext is true", async () => {
    const calls: string[] = [];
    const indexer = makeIndexer({
      searchWithContext: async (q) => {
        calls.push(`withContext:${q}`);
        return [];
      },
      search: async (q) => {
        calls.push(`search:${q}`);
        return [];
      },
    });
    harness = await makeHarness(indexer);
    await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "auth", includeGraphContext: true },
    });
    expect(calls).toEqual(["withContext:auth"]);
  });

  test("calls search when includeGraphContext is false", async () => {
    const calls: string[] = [];
    const indexer = makeIndexer({
      searchWithContext: async (q) => {
        calls.push(`withContext:${q}`);
        return [];
      },
      search: async (q) => {
        calls.push(`search:${q}`);
        return [];
      },
    });
    harness = await makeHarness(indexer);
    await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "auth", includeGraphContext: false },
    });
    expect(calls).toEqual(["search:auth"]);
  });

  test("returns flattened results with loc field", async () => {
    const fakeResult = {
      chunk: {
        id: "c1",
        projectId: "p",
        filePath: "src/a.ts",
        language: "typescript",
        type: "function",
        name: "foo",
        content: "function foo() {}",
        contextContent: "import x;\n\nfunction foo() {}",
        startLine: 1,
        endLine: 3,
        metadata: {},
      },
      score: 0.9452,
      matchType: "lexical" as const,
    } satisfies import("../types.js").SearchResult;
    harness = await makeHarness(
      makeIndexer({ search: async (_q: string) => [fakeResult] }),
    );
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "foo", includeGraphContext: false },
    });
    const payload = parseToolPayload(result);
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    const r = results[0] ?? ({} as Record<string, unknown>);
    // Flat structure — no chunk nesting
    expect(r.id).toBe("c1");
    expect(r.loc).toBe("src/a.ts:1-3");
    expect(r.content).toBe("function foo() {}");
    expect(r.score).toBe(0.95); // rounded to 2dp
    // Internal / verbose fields absent
    expect(r.chunk).toBeUndefined();
    expect(r.language).toBeUndefined();
    expect(r.matchType).toBeUndefined();
    expect(r.metadata).toBeUndefined(); // empty metadata omitted
    expect(r.filePath).toBeUndefined();
    expect(r.startLine).toBeUndefined();
    expect(r.endLine).toBeUndefined();
  });

  test("strips content when includeContent is false", async () => {
    const fakeResult = {
      chunk: {
        id: "c2",
        projectId: "p",
        filePath: "src/b.ts",
        language: "typescript",
        type: "function",
        name: "bar",
        content: "function bar() {}",
        contextContent: "",
        startLine: 5,
        endLine: 5,
        metadata: {},
      },
      score: 0.8,
      matchType: "lexical" as const,
    } satisfies import("../types.js").SearchResult;
    harness = await makeHarness(
      makeIndexer({ search: async (_q: string) => [fakeResult] }),
    );
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: {
        query: "bar",
        includeGraphContext: false,
        includeContent: false,
      },
    });
    const payload = parseToolPayload(result);
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    const r2 = results[0] ?? ({} as Record<string, unknown>);
    expect(r2.content).toBeUndefined();
    expect(r2.id).toBe("c2");
    expect(r2.loc).toBe("src/b.ts:5-5");
  });

  test("returns pagination fields in payload", async () => {
    // Return 11 results to trigger hasMore
    const makeResult = (i: number) =>
      ({
        chunk: {
          id: `c${i}`,
          projectId: "p",
          filePath: `src/${i}.ts`,
          language: "typescript",
          type: "function" as const,
          content: "",
          contextContent: "",
          startLine: 1,
          endLine: 1,
          metadata: {},
        },
        score: 1 - i * 0.01,
        matchType: "lexical" as const,
      }) satisfies import("../types.js").SearchResult;

    harness = await makeHarness(
      makeIndexer({
        search: async (_q: string) =>
          Array.from({ length: 11 }, (_, i) => makeResult(i)),
      }),
    );
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: { query: "x", includeGraphContext: false, limit: 10 },
    });
    const payload = parseToolPayload(result);
    expect(payload.hasMore).toBe(true);
    expect(payload.total).toBe(11);
    expect(payload.offset).toBeUndefined(); // not included on first page
    const results = payload.results as unknown[];
    expect(results).toHaveLength(10);
  });

  test("includes offset in payload when paginating", async () => {
    const makeResult = (i: number) =>
      ({
        chunk: {
          id: `c${i}`,
          projectId: "p",
          filePath: `src/${i}.ts`,
          language: "typescript",
          type: "function" as const,
          content: "",
          contextContent: "",
          startLine: 1,
          endLine: 1,
          metadata: {},
        },
        score: 1 - i * 0.01,
        matchType: "lexical" as const,
      }) satisfies import("../types.js").SearchResult;

    harness = await makeHarness(
      makeIndexer({
        search: async (_q: string) =>
          Array.from({ length: 6 }, (_, i) => makeResult(i)),
      }),
    );
    const result = await harness.client.callTool({
      name: "search_codebase",
      arguments: {
        query: "x",
        includeGraphContext: false,
        limit: 5,
        offset: 5,
      },
    });
    const payload = parseToolPayload(result);
    expect(payload.offset).toBe(5);
    expect(payload.hasMore).toBe(false);
    const results = payload.results as unknown[];
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// get_neighbors
// ---------------------------------------------------------------------------

describe("get_neighbors", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.cleanup();
  });

  test("calls getNeighborhood with the given chunkId", async () => {
    const calls: string[] = [];
    const indexer = makeIndexer({
      getNeighborhood: async (id) => {
        calls.push(id);
        return {
          center: null as unknown as GraphNeighborhood["center"],
          edges: [],
        };
      },
    });
    harness = await makeHarness(indexer);
    await harness.client.callTool({
      name: "get_neighbors",
      arguments: { chunkId: "chunk-xyz" },
    });
    expect(calls).toEqual(["chunk-xyz"]);
  });

  test("returns neighborhood JSON in content", async () => {
    const neighborhood: GraphNeighborhood = {
      center: {
        id: "c1",
        projectId: "p",
        filePath: "src/a.ts",
        language: "typescript",
        type: "function",
        name: "foo",
        content: "function foo() {}",
        contextContent: "",
        startLine: 1,
        endLine: 1,
        metadata: {},
      },
      edges: [],
    };
    harness = await makeHarness(
      makeIndexer({ getNeighborhood: async () => neighborhood }),
    );
    const result = await harness.client.callTool({
      name: "get_neighbors",
      arguments: { chunkId: "c1" },
    });
    const parsed = parseToolPayload(result);
    expect((parsed.center as { id: string }).id).toBe("c1");
    expect(parsed.edges).toEqual([]);
  });
});
