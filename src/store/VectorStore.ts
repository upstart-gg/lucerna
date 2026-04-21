import type {
  ChunkType,
  CodeChunk,
  Language,
  SearchOptions,
  SearchResult,
} from "../types.js";

/**
 * Abstract vector store interface.
 * Implement this to swap in a different backend (Qdrant, Weaviate, etc.).
 */
export interface VectorStore {
  /** Insert or update chunks. If a chunk with the same id exists, it is replaced. */
  upsert(chunks: CodeChunk[], vectors: number[][]): Promise<void>;

  /** Remove chunks by their ids. */
  delete(ids: string[]): Promise<void>;

  /** Remove all chunks whose filePath matches the given value. */
  deleteByFile(filePath: string): Promise<void>;

  /** Vector (semantic) nearest-neighbour search. */
  searchVector(
    queryVector: number[],
    options: SearchOptions,
  ): Promise<SearchResult[]>;

  /** Full-text / BM25 search. */
  searchText(query: string, options: SearchOptions): Promise<SearchResult[]>;

  /**
   * Native hybrid (vector + FTS) search fused via RRF in a single query.
   * Optional — stores that don't implement this fall back to the two-query
   * RRF path in Searcher.
   */
  searchHybrid?(
    queryVector: number[],
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]>;

  /** Return all distinct filePaths stored. */
  listFiles(): Promise<string[]>;

  /** Return all chunks for a given filePath. */
  getChunksByFile(filePath: string): Promise<CodeChunk[]>;

  /** Return chunks by their IDs (bulk lookup for graph traversal). */
  getChunksByIds(ids: string[]): Promise<CodeChunk[]>;

  /** Return the total number of chunks stored. */
  count(): Promise<number>;

  /** Return chunk counts grouped by language. */
  countByLanguage(): Promise<Partial<Record<Language, number>>>;

  /** Return chunk counts grouped by chunk type. */
  countByType(): Promise<Partial<Record<ChunkType, number>>>;

  /**
   * Return all top-level symbols (functions, classes, methods, etc.) — used to
   * build the repo map.
   */
  getAllSymbols(): Promise<
    Array<{
      filePath: string;
      type: string;
      name: string;
      startLine: number;
      endLine: number;
    }>
  >;

  /** Release all resources (close DB connection). */
  close(): Promise<void>;

  /**
   * Compact data files and refresh indexes after batch writes.
   * Optional — stores that don't need explicit optimization can omit it.
   * `vacuum: true` requests the most expensive full rewrite/compaction
   * (e.g. SQLite `VACUUM`); callers should reserve it for end-of-batch,
   * not per-watcher-event calls.
   */
  optimize?(opts?: { vacuum?: boolean }): Promise<void>;
}
