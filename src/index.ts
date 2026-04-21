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
export { CloudflareEmbeddings } from "./embeddings/CloudflareEmbeddings.js";
export { CloudflareReranker } from "./embeddings/CloudflareReranker.js";
export { CohereEmbeddings } from "./embeddings/CohereEmbeddings.js";
export { CohereReranker } from "./embeddings/CohereReranker.js";
export { GeminiEmbeddings } from "./embeddings/GeminiEmbeddings.js";
export { GeminiReranker } from "./embeddings/GeminiReranker.js";
export { JinaEmbeddings } from "./embeddings/JinaEmbeddings.js";
export { JinaReranker } from "./embeddings/JinaReranker.js";
export { MistralEmbeddings } from "./embeddings/MistralEmbeddings.js";
export { LMStudioEmbeddings } from "./embeddings/LMStudioEmbeddings.js";
export { OllamaEmbeddings } from "./embeddings/OllamaEmbeddings.js";
export { OpenAIEmbeddings } from "./embeddings/OpenAIEmbeddings.js";
export { VertexAIEmbeddings } from "./embeddings/VertexAIEmbeddings.js";
export { VertexAIReranker } from "./embeddings/VertexAIReranker.js";
export { VoyageEmbeddings } from "./embeddings/VoyageEmbeddings.js";
export { VoyageReranker } from "./embeddings/VoyageReranker.js";
// Graph (for standalone use)
export { GraphTraverser, SymbolResolver } from "./graph/index.js";
// Search engine (for standalone use)
export { Searcher } from "./search/Searcher.js";
export {
  createStoreBundle,
  type CreateStoreBundleOptions,
  type StoreBundle,
  type VectorStoreBackend,
} from "./store/factory.js";
export { GraphStore } from "./store/GraphStore.js";
export type { GraphStoreInterface } from "./store/GraphStoreInterface.js";
export { LanceDBStore } from "./store/LanceDBStore.js";
export { SqliteGraphStore } from "./store/SqliteGraphStore.js";
export { SqliteVectorStore } from "./store/SqliteVectorStore.js";
// Store (for custom backends)
export type { VectorStore } from "./store/VectorStore.js";
// Config helper
export { defineConfig } from "./config.js";
// Types
export type {
  ChunkType,
  CodeChunk,
  CodeIndexOptions,
  EmbeddingFunction,
  EmbeddingProviderConfig,
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
  RerankingProviderConfig,
  SearchOptions,
  SearchResult,
  SearchWithContextOptions,
} from "./types.js";
