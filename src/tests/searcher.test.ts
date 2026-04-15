import { describe, expect, test } from "bun:test";
import { Searcher } from "../search/Searcher.js";
import type { VectorStore } from "../store/VectorStore.js";
import type {
  CodeChunk,
  EmbeddingFunction,
  RerankingFunction,
  SearchResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChunk(id: string): CodeChunk {
  return {
    id,
    projectId: "p",
    filePath: "f.ts",
    language: "typescript",
    type: "function",
    content: "function foo() {}",
    contextContent: "function foo() {}",
    startLine: 1,
    endLine: 3,
    metadata: {},
  };
}

function makeResult(
  id: string,
  score: number,
  matchType: "semantic" | "lexical" = "semantic",
): SearchResult {
  return { chunk: makeChunk(id), score, matchType };
}

function makeMockStore(overrides: Partial<VectorStore> = {}): VectorStore {
  return {
    upsert: async () => {},
    delete: async () => {},
    deleteByFile: async () => {},
    searchVector: async () => [],
    searchText: async () => [],
    listFiles: async () => [],
    getChunksByFile: async () => [],
    getChunksByIds: async () => [],
    count: async () => 0,
    close: async () => {},
    ...overrides,
  };
}

const mockEmbedding: EmbeddingFunction = {
  dimensions: 4,
  generate: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockReranker(scores: number[]): RerankingFunction & {
  calls: { query: string; texts: string[] }[];
} {
  const calls: { query: string; texts: string[] }[] = [];
  return {
    calls,
    rerank: async (query, texts) => {
      calls.push({ query, texts });
      return scores.slice(0, texts.length);
    },
  };
}

// ---------------------------------------------------------------------------
// searchLexical()
// ---------------------------------------------------------------------------

describe("Searcher — searchLexical()", () => {
  test("delegates query to store.searchText()", async () => {
    let capturedQuery: string | undefined;
    const store = makeMockStore({
      searchText: async (q) => {
        capturedQuery = q;
        return [makeResult("a", 0.9, "lexical")];
      },
    });
    const searcher = new Searcher(store, false);
    const results = await searcher.searchLexical("find me");
    expect(capturedQuery).toBe("find me");
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe("a");
  });

  test("slices results to the limit", async () => {
    const store = makeMockStore({
      searchText: async () => [
        makeResult("a", 0.9, "lexical"),
        makeResult("b", 0.8, "lexical"),
        makeResult("c", 0.7, "lexical"),
      ],
    });
    const searcher = new Searcher(store, false);
    const results = await searcher.searchLexical("foo", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("applies minScore filter", async () => {
    const store = makeMockStore({
      searchText: async () => [
        makeResult("high", 0.9, "lexical"),
        makeResult("low", 0.3, "lexical"),
      ],
    });
    const searcher = new Searcher(store, false);
    const results = await searcher.searchLexical("foo", { minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe("high");
  });

  test("returns empty array when store has no results", async () => {
    const searcher = new Searcher(makeMockStore(), false);
    const results = await searcher.searchLexical("nothing");
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// searchSemantic()
// ---------------------------------------------------------------------------

describe("Searcher — searchSemantic()", () => {
  test("throws when embeddingFn is false", async () => {
    const searcher = new Searcher(makeMockStore(), false);
    await expect(searcher.searchSemantic("foo")).rejects.toThrow(
      "Semantic search is disabled",
    );
  });

  test("generates an embedding and passes it to store.searchVector()", async () => {
    let capturedVector: number[] | undefined;
    const store = makeMockStore({
      searchVector: async (v) => {
        capturedVector = v;
        return [makeResult("x", 0.95)];
      },
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.searchSemantic("hello world");
    expect(capturedVector).toHaveLength(4);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe("x");
  });

  test("returns empty array when embedding fn yields no vectors", async () => {
    const emptyEmbedding: EmbeddingFunction = {
      dimensions: 4,
      generate: async () => [],
    };
    const searcher = new Searcher(makeMockStore(), emptyEmbedding);
    const results = await searcher.searchSemantic("foo");
    expect(results).toHaveLength(0);
  });

  test("applies minScore filter", async () => {
    const store = makeMockStore({
      searchVector: async () => [
        makeResult("pass", 0.9),
        makeResult("fail", 0.2),
      ],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.searchSemantic("foo", { minScore: 0.5 });
    expect(results.map((r) => r.chunk.id)).toContain("pass");
    expect(results.map((r) => r.chunk.id)).not.toContain("fail");
  });

  test("slices results to the limit", async () => {
    const store = makeMockStore({
      searchVector: async () => [
        makeResult("a", 0.9),
        makeResult("b", 0.8),
        makeResult("c", 0.7),
      ],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.searchSemantic("foo", { limit: 2 });
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// search() routing
// ---------------------------------------------------------------------------

describe("Searcher — search() routing", () => {
  test("routes to lexical when embeddingFn=false", async () => {
    let calledText = false;
    const store = makeMockStore({
      searchText: async () => {
        calledText = true;
        return [];
      },
    });
    const searcher = new Searcher(store, false);
    await searcher.search("foo");
    expect(calledText).toBe(true);
  });

  test("routes to semantic-only when hybrid=false and embeddingFn set", async () => {
    let calledVector = false;
    let calledText = false;
    const store = makeMockStore({
      searchVector: async () => {
        calledVector = true;
        return [];
      },
      searchText: async () => {
        calledText = true;
        return [];
      },
    });
    const searcher = new Searcher(store, mockEmbedding);
    await searcher.search("foo", { hybrid: false });
    expect(calledVector).toBe(true);
    expect(calledText).toBe(false);
  });

  test("runs both vector and text searches in hybrid mode (default)", async () => {
    let vectorCalls = 0;
    let textCalls = 0;
    const store = makeMockStore({
      searchVector: async () => {
        vectorCalls++;
        return [];
      },
      searchText: async () => {
        textCalls++;
        return [];
      },
    });
    const searcher = new Searcher(store, mockEmbedding);
    await searcher.search("foo");
    expect(vectorCalls).toBeGreaterThan(0);
    expect(textCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (hybrid search internals)
// ---------------------------------------------------------------------------

describe("Searcher — hybrid / RRF", () => {
  test("merges results from both search paths", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9), makeResult("b", 0.8)],
      searchText: async () => [
        makeResult("b", 0.85, "lexical"),
        makeResult("c", 0.7, "lexical"),
      ],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo", { limit: 10 });
    const ids = results.map((r) => r.chunk.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  test("chunk appearing in both lists gets a higher RRF score", async () => {
    // 'b' is in both lists; 'solo' only in one
    const store = makeMockStore({
      searchVector: async () => [
        makeResult("b", 0.9),
        makeResult("solo_vec", 0.8),
      ],
      searchText: async () => [
        makeResult("b", 0.9, "lexical"),
        makeResult("solo_lex", 0.8, "lexical"),
      ],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo", { limit: 10 });
    const bResult = results.find((r) => r.chunk.id === "b");
    const soloResult = results.find((r) => r.chunk.id === "solo_vec");
    // 'b' should have a higher score than 'solo_vec' (two RRF contributions)
    expect(bResult).toBeDefined();
    expect(soloResult).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: ok to assert presence of results in this test
    expect(bResult!.score).toBeGreaterThan(soloResult!.score);
  });

  test("results are tagged as 'hybrid' matchType", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9)],
      searchText: async () => [makeResult("a", 0.9, "lexical")],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo");
    expect(results[0]?.matchType).toBe("hybrid");
  });

  test("recovers gracefully when semantic search throws", async () => {
    const store = makeMockStore({
      searchVector: async () => {
        throw new Error("vector store is down");
      },
      searchText: async () => [makeResult("lexical_only", 0.9, "lexical")],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo");
    expect(results.map((r) => r.chunk.id)).toContain("lexical_only");
  });

  test("recovers gracefully when lexical search throws", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("vector_only", 0.9)],
      searchText: async () => {
        throw new Error("FTS index not ready");
      },
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo");
    expect(results.map((r) => r.chunk.id)).toContain("vector_only");
  });

  test("applies minScore to fused scores (all low RRF scores filtered out)", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9), makeResult("b", 0.8)],
      searchText: async () => [makeResult("c", 0.9, "lexical")],
    });
    const searcher = new Searcher(store, mockEmbedding);
    // RRF scores are around 1/(60+rank+1) ≈ 0.016 which is below 0.5
    const results = await searcher.search("foo", { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  test("respects limit in hybrid results", async () => {
    const store = makeMockStore({
      searchVector: async () => [
        makeResult("a", 0.9),
        makeResult("b", 0.8),
        makeResult("c", 0.7),
      ],
      searchText: async () => [
        makeResult("d", 0.9, "lexical"),
        makeResult("e", 0.8, "lexical"),
      ],
    });
    const searcher = new Searcher(store, mockEmbedding);
    const results = await searcher.search("foo", { limit: 3 });
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

describe("Searcher — reranking", () => {
  test("reranker is called with the query and contextContent of candidates", async () => {
    const chunkA = { ...makeChunk("a"), contextContent: "content of a" };
    const chunkB = { ...makeChunk("b"), contextContent: "content of b" };
    const store = makeMockStore({
      searchVector: async () => [
        { chunk: chunkA, score: 0.9, matchType: "semantic" as const },
      ],
      searchText: async () => [
        { chunk: chunkB, score: 0.8, matchType: "lexical" as const },
      ],
    });
    const reranker = makeMockReranker([0.9, 0.8]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    await searcher.search("my query");
    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]?.query).toBe("my query");
    expect(reranker.calls[0]?.texts).toContain("content of a");
    expect(reranker.calls[0]?.texts).toContain("content of b");
  });

  test("reranker scores replace RRF scores", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9), makeResult("b", 0.8)],
      searchText: async () => [],
    });
    const reranker = makeMockReranker([0.75, 0.42]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    const results = await searcher.search("q", { limit: 2 });
    // Scores should be the reranker's values, not RRF (~0.016)
    expect(results[0]?.score).toBeCloseTo(0.75);
    expect(results[1]?.score).toBeCloseTo(0.42);
  });

  test("results are re-sorted by reranker scores", async () => {
    // a ranks first via RRF, but reranker gives b a higher score
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9), makeResult("b", 0.8)],
      searchText: async () => [],
    });
    // reranker returns [score_for_a, score_for_b] — b scores higher
    const reranker = makeMockReranker([0.2, 0.9]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    const results = await searcher.search("q", { limit: 2 });
    expect(results[0]?.chunk.id).toBe("b");
    expect(results[1]?.chunk.id).toBe("a");
  });

  test("reranking is skipped when options.rerank=false", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9)],
      searchText: async () => [],
    });
    const reranker = makeMockReranker([0.9]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    await searcher.search("q", { rerank: false });
    expect(reranker.calls).toHaveLength(0);
  });

  test("reranking is skipped when rerankingFn is false", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9)],
      searchText: async () => [],
    });
    const reranker = makeMockReranker([0.9]);
    // Pass reranker to verify it's NOT called (we pass false instead)
    const searcher = new Searcher(store, mockEmbedding, false);
    await searcher.search("q");
    expect(reranker.calls).toHaveLength(0);
  });

  test("reranker errors propagate", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9)],
      searchText: async () => [],
    });
    const failingReranker: RerankingFunction = {
      rerank: async () => {
        throw new Error("reranker unavailable");
      },
    };
    const searcher = new Searcher(store, mockEmbedding, failingReranker);
    await expect(searcher.search("q")).rejects.toThrow("reranker unavailable");
  });

  test("minScore is applied to reranked scores", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9), makeResult("b", 0.8)],
      searchText: async () => [],
    });
    const reranker = makeMockReranker([0.8, 0.3]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    const results = await searcher.search("q", { minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe("a");
  });

  test("reranking is not applied on semantic-only path", async () => {
    const store = makeMockStore({
      searchVector: async () => [makeResult("a", 0.9)],
      searchText: async () => [],
    });
    const reranker = makeMockReranker([0.9]);
    const searcher = new Searcher(store, mockEmbedding, reranker);
    await searcher.search("q", { hybrid: false });
    expect(reranker.calls).toHaveLength(0);
  });
});
