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
    expect(payload.warning).toInclude("indexing");
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

  test("returns results array in payload", async () => {
    const fakeResult = {
      chunk: {
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
      score: 0.9,
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
    const results = payload.results as Array<{ chunk: { id: string } }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe("c1");
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
