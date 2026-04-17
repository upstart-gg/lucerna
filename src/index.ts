/**
 * lucerna — AST-aware semantic + lexical code indexer for AI agents.
 *
 * @example
 * ```ts
 * import { CodeIndexer } from 'lucerna';
 *
 * const indexer = new CodeIndexer({ projectRoot: '/path/to/project' });
 * await indexer.initialize();
 * await indexer.indexProject();
 *
 * const results = await indexer.search('authentication middleware');
 * console.log(results);
 *
 * // Graph traversal
 * const neighbourhood = await indexer.getNeighborhood(results[0].chunk.id);
 * const callers = await indexer.getCallers(results[0].chunk.id);
 *
 * await indexer.close();
 * ```
 */

// Main class
export { CodeIndexer } from "./CodeIndexer.js";
// Chunker (for standalone use)
export { TreeSitterChunker } from "./chunker/index.js";

// Embeddings
export { BGESmallEmbeddings } from "./embeddings/BGESmallEmbeddings.js";
export { CloudflareEmbeddings } from "./embeddings/CloudflareEmbeddings.js";
export { CloudflareReranker } from "./embeddings/CloudflareReranker.js";
export { HFEmbeddings } from "./embeddings/HFEmbeddings.js";
export { JinaReranker } from "./embeddings/JinaReranker.js";
export { NomicCodeEmbeddings } from "./embeddings/NomicCodeEmbeddings.js";
export { VoyageReranker } from "./embeddings/VoyageReranker.js";
// Graph (for standalone use)
export { GraphTraverser, SymbolResolver } from "./graph/index.js";
// Search engine (for standalone use)
export { Searcher } from "./search/Searcher.js";
export { GraphStore } from "./store/GraphStore.js";
export { LanceDBStore } from "./store/LanceDBStore.js";
// Store (for custom backends)
export type { VectorStore } from "./store/VectorStore.js";
// Types
export type {
  ChunkType,
  CodeChunk,
  CodeIndexOptions,
  EmbeddingFunction,
  EvalQuery,
  GraphEdge,
  GraphNeighborhood,
  GraphTraversalOptions,
  IndexEvent,
  IndexStats,
  Language,
  LucernaConfig,
  // Graph types
  RelationshipType,
  RepoMapOptions,
  RerankingFunction,
  SearchOptions,
  SearchResult,
  SearchWithContextOptions,
} from "./types.js";
