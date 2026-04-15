import type { CodeChunk, SearchOptions, SearchResult } from "../types.js";

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

  /** Return all distinct filePaths stored. */
  listFiles(): Promise<string[]>;

  /** Return all chunks for a given filePath. */
  getChunksByFile(filePath: string): Promise<CodeChunk[]>;

  /** Return chunks by their IDs (bulk lookup for graph traversal). */
  getChunksByIds(ids: string[]): Promise<CodeChunk[]>;

  /** Return the total number of chunks stored. */
  count(): Promise<number>;

  /** Release all resources (close DB connection). */
  close(): Promise<void>;
}
