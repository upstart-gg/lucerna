import type { VectorStore } from "../store/VectorStore.js";
import type {
  EmbeddingFunction,
  RerankingFunction,
  SearchOptions,
  SearchResult,
} from "../types.js";

const DEFAULT_RRF_K = 45; // code retrieval is better served by ~45 than the doc-IR default of 60

/**
 * Hybrid search engine combining vector (semantic) and BM25 (lexical) search
 * via Reciprocal Rank Fusion (RRF).
 *
 * When no embedding function is configured, falls back to lexical-only search.
 * When lexical search is unavailable, falls back to semantic-only.
 *
 * Results are always sorted by internal relevance score (best first); the
 * score itself is not exposed on `SearchResult` because it is not comparable
 * across search paths. Callers should rely on the result order.
 */
export class Searcher {
  private readonly store: VectorStore;
  private readonly embeddingFn: EmbeddingFunction | false;
  private readonly rerankingFn: RerankingFunction | false;

  constructor(
    store: VectorStore,
    embeddingFn: EmbeddingFunction | false,
    rerankingFn?: RerankingFunction | false,
  ) {
    this.store = store;
    this.embeddingFn = embeddingFn;
    this.rerankingFn = rerankingFn ?? false;
  }

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const useHybrid = options.hybrid !== false && this.embeddingFn !== false;

    let results: SearchResult[];
    if (useHybrid) {
      results = await this.hybridSearch(query, options);
    } else if (this.embeddingFn !== false) {
      results = await this.searchSemantic(query, options);
    } else {
      results = await this.searchLexical(query, options);
    }
    return dedupeById(results);
  }

  async searchSemantic(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    if (this.embeddingFn === false) {
      throw new Error(
        "Semantic search is disabled (embeddingFunction: false). Use searchLexical() instead.",
      );
    }
    const vector = await embedQueryVector(this.embeddingFn, query);
    if (!vector) return [];
    const limit = options.limit ?? 10;
    const results = await this.store.searchVector(vector, {
      ...options,
      limit: limit * 2,
    });
    return results.slice(0, limit);
  }

  async searchLexical(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const results = await this.store.searchText(query, {
      ...options,
      limit: limit * 2,
    });
    return results.slice(0, limit);
  }

  private async hybridSearch(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const innerOpts = { ...options, limit: limit * 3 };
    const shouldRerank = this.rerankingFn !== false && options.rerank !== false;

    let fused: SearchResult[];

    if (this.store.searchHybrid) {
      // Native path: single round-trip, LanceDB handles RRF fusion
      const vector = await embedQueryVector(
        this.embeddingFn as EmbeddingFunction,
        query,
      );
      if (!vector) return [];
      fused = (
        await this.store
          .searchHybrid(vector, query, innerOpts)
          .catch(() => this.fallbackTwoQuery(query, innerOpts))
      ).map((r) => ({ ...r, matchType: "hybrid" as const }));
    } else {
      fused = await this.fallbackTwoQuery(query, innerOpts);
    }

    if (shouldRerank && fused.length > 0) {
      const reranked = await applyReranking(
        query,
        fused,
        this.rerankingFn as RerankingFunction,
      );
      return reranked.slice(0, limit);
    }

    return fused.slice(0, limit);
  }

  private async fallbackTwoQuery(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const [semanticResults, lexicalResults] = await Promise.all([
      this.searchSemantic(query, options).catch(() => [] as SearchResult[]),
      this.searchLexical(query, options).catch(() => [] as SearchResult[]),
    ]);
    return reciprocalRankFusion(
      semanticResults,
      lexicalResults,
      limit,
      options.rrfK ?? DEFAULT_RRF_K,
    );
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

function reciprocalRankFusion(
  semanticResults: SearchResult[],
  lexicalResults: SearchResult[],
  limit: number,
  k: number,
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();

  const addResults = (results: SearchResult[]) => {
    results.forEach((result, rank) => {
      const id = result.chunk.id;
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(id, { result, score: rrfScore });
      }
    });
  };

  addResults(semanticResults);
  addResults(lexicalResults);

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result }) => ({ ...result, matchType: "hybrid" as const }));
}

/**
 * Keep the first occurrence of each chunk id. RRF already dedupes, but native
 * backend paths (e.g. LanceDB hybrid) don't always — this is the single
 * guarantee point callers can rely on.
 */
function dedupeById(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.chunk.id)) continue;
    seen.add(r.chunk.id);
    out.push(r);
  }
  return out;
}

async function embedQueryVector(
  fn: EmbeddingFunction,
  query: string,
): Promise<number[] | undefined> {
  if (fn.embedQuery) return fn.embedQuery(query);
  const [v] = await fn.generate([query]);
  return v;
}

async function applyReranking(
  query: string,
  results: SearchResult[],
  rerankFn: RerankingFunction,
): Promise<SearchResult[]> {
  const texts = results.map((r) => r.chunk.contextContent);
  const scores = await rerankFn.rerank(query, texts);
  // Score is used only for ordering and then stripped.
  return results
    .map((result, i) => ({ result, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => result);
}
