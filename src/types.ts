/**
 * Core types for the lucerna library.
 */

// ---------------------------------------------------------------------------
// Languages & chunk types
// ---------------------------------------------------------------------------

/**
 * A language identifier string.
 * Well-known values: "typescript" | "javascript" | "json" | "markdown"
 * Any language supported by @kreuzberg/tree-sitter-language-pack (305 total) is accepted.
 */
export type Language = string;

export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "import"
  | "section" // markdown heading section
  | "file" // whole-file fallback
  | "enum"
  | "const"
  | "macro"
  | "namespace"
  | "struct"
  | "record"
  | "protocol"
  | "trait"
  | "mixin"
  | "extension"
  | "object"
  | "actor"
  | "typealias"
  | "module"
  | "property"
  | "instance"
  | "newtype"
  | "functor"
  | "module_type"
  | "test"
  | "param_block"
  | "dsl_call"
  | "state_variable"
  | "event"
  | "modifier"
  | "error"
  | "library";

// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

/**
 * An atomic, searchable unit extracted from a source file.
 */
export interface CodeChunk {
  /** Stable ID: hash(projectId + filePath + startLine) */
  id: string;
  /** Identifies which project this chunk belongs to (for multi-project isolation) */
  projectId: string;
  /** File path relative to projectRoot */
  filePath: string;
  language: Language;
  type: ChunkType;
  /** Symbol name (function/class/method/heading), if applicable */
  name?: string;
  /** Raw source text of this chunk */
  content: string;
  /**
   * Enriched content used for embedding:
   * imports + class header (if inside a class) + content.
   * Better retrieval accuracy than embedding bare content.
   */
  contextContent: string;
  startLine: number;
  endLine: number;
  /** Arbitrary extra metadata — language-specific, user-extensible */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Pluggable embedding function. Implement this interface to swap out the
 * default @huggingface/transformers-based embedder.
 */
export interface EmbeddingFunction {
  /** Dimensionality of the output vectors */
  readonly dimensions: number;
  /**
   * Optional stable identifier for the model (e.g. `"Xenova/bge-small-en-v1.5"`).
   * When set, lucerna persists this alongside the index and warns if the configured
   * model changes between runs — preventing silent vector-space corruption.
   */
  readonly modelId?: string;
  /** Produce one embedding vector per input text (document-side / indexing). */
  generate(texts: string[]): Promise<number[][]>;
  /**
   * Optional query-side embedding. Providers that support asymmetric retrieval
   * (e.g. Gemini/Vertex `CODE_RETRIEVAL_QUERY`) implement this to embed user
   * queries differently from documents. When absent, callers should fall back
   * to `generate([text])[0]`.
   */
  embedQuery?(text: string): Promise<number[]>;
  /** Optional: pre-load the model so the first generate() call has no cold-start delay */
  warmup?(): Promise<void>;
}

/**
 * Pluggable reranking function. Takes a query and candidate texts, returns one
 * relevance score per text (higher = more relevant). Used as a second-stage
 * re-scorer after RRF fusion to improve final result precision.
 *
 * Scores should be in the 0–1 range so they are compatible with `minScore`.
 */
export interface RerankingFunction {
  /** Score each text against the query. Returns one score per input text, in the same order. */
  rerank(query: string, texts: string[]): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  chunk: CodeChunk;
  /** Normalised relevance score (higher = more relevant) */
  score: number;
  matchType: "semantic" | "lexical" | "hybrid";
}

export interface SearchOptions {
  /** Max results to return (default: 10) */
  limit?: number;
  /** Restrict results to one or more languages */
  language?: Language | Language[];
  /** Restrict results to certain chunk types */
  types?: ChunkType[];
  /** Filter by file path — supports glob patterns */
  filePath?: string;
  /**
   * Use hybrid search (vector + BM25 combined via RRF).
   * Defaults to true when an embedding function is configured.
   */
  hybrid?: boolean;
  /** Minimum score threshold for results (0–1 range after normalisation) */
  minScore?: number;
  /**
   * Whether to apply reranking after RRF fusion.
   * Defaults to true when a `rerankingFunction` is configured on the indexer.
   * Set to false to skip reranking for a specific query.
   */
  rerank?: boolean;
  /**
   * The RRF rank constant k. Lower values weight top-ranked results more heavily.
   * k=45 is better calibrated for code retrieval than the document-IR default of 60.
   * Default: 45.
   */
  rrfK?: number;
}

// ---------------------------------------------------------------------------
// Repo map
// ---------------------------------------------------------------------------

export interface RepoMapOptions {
  /** Max number of files to include (sorted by symbol count desc). Default: unlimited. */
  maxFiles?: number;
  /** Chunk types to include. Defaults to top-level symbols (function, class, interface, type, enum). */
  types?: ChunkType[];
  /** Output format: 'text' (human-readable) or 'json'. Default: 'text'. */
  format?: "text" | "json";
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * A single query in a recall@k evaluation set.
 * The eval command reads a JSONL file of these objects and checks whether
 * the expected file (and optionally symbol) appears in the top-k results.
 */
export interface EvalQuery {
  query: string;
  /** Relative file path expected to appear in search results */
  expectedFile: string;
  /** Optional: symbol name (chunk.name) that must match within expectedFile */
  expectedSymbol?: string;
}

// ---------------------------------------------------------------------------
// Indexer options
// ---------------------------------------------------------------------------

export interface IndexEvent {
  type: "indexed" | "removed" | "error";
  filePath: string;
  chunksAffected?: number;
  error?: Error;
}

export interface CodeIndexOptions {
  /** Absolute path to the project root */
  projectRoot: string;
  /**
   * Stable identifier for this project's index.
   * Defaults to a hash of projectRoot.
   * Used to namespace the LanceDB table so multiple projects never collide.
   */
  projectId?: string;
  /**
   * Directory where the index data is persisted.
   * Defaults to `<projectRoot>/.lucerna`.
   */
  storageDir?: string;
  /**
   * Glob patterns (relative to projectRoot) of files to index.
   * Defaults to "**\/*" (all files) — language detection filters out files
   * with no recognized extension, so unknown file types produce no chunks.
   * .gitignore rules are always respected regardless of this setting.
   */
  include?: string[];
  /**
   * Glob patterns (relative to projectRoot) of files to exclude.
   * Defaults to node_modules, .git, dist, and the storage dir itself.
   */
  exclude?: string[];
  /**
   * The embedding function to use for semantic search.
   *   - `undefined` (default): auto-load from `lucerna.config.ts` at / above
   *     `projectRoot`. If no config is found, behaves like `false`.
   *   - `false`: explicitly disable semantic search (lexical / BM25 only).
   *     On a fresh storage dir, no vector table is created.
   *   - An `EmbeddingFunction` instance: use the provided embedder verbatim,
   *     bypassing any config file.
   */
  embeddingFunction?: EmbeddingFunction | false;
  /**
   * The reranking function to apply as a second stage after RRF fusion.
   *   - `undefined` (default): auto-load from `lucerna.config.ts` if present,
   *     otherwise no reranking.
   *   - `false`: explicitly disable reranking, skipping config lookup.
   *   - A `RerankingFunction` instance: re-score and re-sort the top candidates.
   */
  rerankingFunction?: RerankingFunction | false;
  /**
   * Approximate maximum number of tokens per chunk.
   * The chunker uses character count as a proxy (1 token ≈ 4 chars).
   * Default: 1500
   */
  maxChunkTokens?: number;
  /** Enable file watching immediately on initialize(). Default: false */
  watch?: boolean;
  /** Debounce delay in ms for file-watch events. Default: 500 */
  watchDebounce?: number;
  /**
   * How often (ms) a follower process polls to check if the indexing leader
   * has exited and leadership can be claimed. Default: 10_000.
   * Override in tests to speed up leader-transfer checks.
   */
  leaderPollMs?: number;
  /** Called after each file is indexed, removed, or errors during indexing */
  onIndexed?: (event: IndexEvent) => void;
  /**
   * Vector store backend to use for persistence.
   *   - `"sqlite"` (default): SQLite + sqlite-vec — single-file, easy to inspect with the `sqlite3` CLI.
   *   - `"lancedb"`: LanceDB — faster for very large repos, native binary.
   *
   * Each backend is an optional dependency; `lucerna install` prompts which one
   * to install. Picking a backend whose package isn't installed yields a clear
   * error pointing at the install command.
   */
  vectorStore?: "lancedb" | "sqlite";
}

// ---------------------------------------------------------------------------
// Knowledge Graph
// ---------------------------------------------------------------------------

export type RelationshipType =
  | "CALLS"
  | "IMPORTS"
  | "DEFINES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "USES";

/**
 * A directed edge between two chunks in the knowledge graph.
 */
export interface GraphEdge {
  /** Stable 16-char hex ID: hash(projectId + sourceChunkId + targetChunkId + type) */
  id: string;
  projectId: string;
  sourceChunkId: string;
  targetChunkId: string;
  type: RelationshipType;
  /** The file path of the source chunk — used for efficient edge deletion on re-index */
  sourceFilePath: string;
  metadata: Record<string, unknown>;
}

/**
 * A chunk plus its immediately related chunks, returned by graph traversal.
 */
export interface GraphNeighborhood {
  center: CodeChunk;
  edges: Array<{
    edge: GraphEdge;
    chunk: CodeChunk;
    direction: "outgoing" | "incoming";
  }>;
}

export interface GraphTraversalOptions {
  /** How many hops to follow. Default: 1 */
  depth?: number;
  /** Filter to specific edge types. Default: all */
  relationTypes?: RelationshipType[];
  /** Max total neighbour chunks to return. Default: 20 */
  limit?: number;
}

export interface SearchWithContextOptions extends SearchOptions {
  /** How many graph hops to expand from each search result. Default: 1 */
  graphDepth?: number;
  /** Which edge types to follow when expanding. Default: all */
  graphRelationTypes?: RelationshipType[];
  /**
   * Score multiplier applied to graph-expanded neighbour results.
   * A value < 1 discounts neighbours relative to the directly-matched chunks.
   * Default: 0.7
   */
  contextScoreDiscount?: number;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/** Built-in embedding provider configuration — no imports needed. */
export type EmbeddingProviderConfig =
  | { provider: "voyage"; model: string; apiKey: string; dimensions?: number }
  | { provider: "openai"; model: string; apiKey: string; dimensions?: number }
  | { provider: "cohere"; model: string; apiKey: string; dimensions?: number }
  | { provider: "jina"; model: string; apiKey: string; dimensions?: number }
  | { provider: "mistral"; model: string; apiKey: string; dimensions?: number }
  | { provider: "gemini"; model: string; apiKey: string; dimensions?: number }
  | { provider: "ollama"; model: string; host?: string; dimensions?: number }
  | {
      provider: "lmstudio";
      model: string;
      baseUrl?: string;
      dimensions?: number;
    }
  | {
      provider: "cloudflare";
      model?: string;
      accountId: string;
      apiKey: string;
      dimensions?: number;
    }
  | {
      provider: "vertex";
      model: string;
      project: string;
      location?: string;
      /** Path to a service account JSON key file. Uses ADC if omitted. */
      keyFile?: string;
      dimensions?: number;
    };

/** Built-in reranking provider configuration — no imports needed. */
export type RerankingProviderConfig =
  | { provider: "voyage"; model?: string; apiKey: string }
  | { provider: "cohere"; model?: string; apiKey: string }
  | { provider: "jina"; model?: string; apiKey: string }
  | { provider: "gemini"; model?: string; apiKey: string }
  | {
      provider: "cloudflare";
      model?: string;
      accountId: string;
      apiKey: string;
    }
  | {
      provider: "vertex";
      model?: string;
      project: string;
      /** Path to a service account JSON key file. Uses ADC if omitted. */
      keyFile?: string;
    };

/**
 * Shape of `lucerna.config.ts` / `lucerna.config.js`.
 *
 * Use `defineConfig()` for autocomplete and type-checking:
 *
 * @example
 * ```ts
 * // lucerna.config.ts
 * import { defineConfig } from '@upstart.gg/lucerna';
 *
 * export default defineConfig({
 *   embedding: { provider: "voyage", model: "voyage-code-3", apiKey: "sk-..." },
 *   include: ["src/**\/*"],
 * });
 * ```
 */
export interface LucernaConfig {
  /**
   * Embedding provider configuration or a custom `EmbeddingFunction` instance.
   *   - Provider config object: `{ provider: "voyage", model: "...", apiKey: "..." }`
   *   - `EmbeddingFunction` instance: advanced/custom provider
   *   - `false`: disable semantic search (lexical/BM25 only)
   *   - `undefined`: semantic search disabled (no provider configured)
   */
  embedding?: EmbeddingProviderConfig | EmbeddingFunction | false;
  /**
   * Reranking provider configuration or a custom `RerankingFunction` instance.
   *   - Provider config object: `{ provider: "voyage", apiKey: "..." }`
   *   - `RerankingFunction` instance: advanced/custom provider
   *   - `false` or `undefined`: no reranking (RRF fusion still applies)
   */
  reranking?: RerankingProviderConfig | RerankingFunction | false;
  /**
   * Glob patterns (relative to project root) of files to index.
   * Defaults to `["**\/*"]` (all files).
   */
  include?: string[];
  /**
   * Additional glob patterns to exclude on top of the built-in exclusions
   * (node_modules, .git, dist, lock files, binary files, etc.).
   */
  exclude?: string[];
  /**
   * Vector store backend to use for persistence.
   *   - `"sqlite"` (default): SQLite + sqlite-vec — single-file, easy to inspect with the `sqlite3` CLI.
   *   - `"lancedb"`: LanceDB — faster for very large repos, native binary.
   */
  vectorStore?: "lancedb" | "sqlite";
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface IndexStats {
  projectId: string;
  projectRoot: string;
  totalFiles: number;
  totalChunks: number;
  totalEdges: number;
  byLanguage: Partial<Record<Language, number>>;
  byType: Partial<Record<ChunkType, number>>;
  byEdgeType: Partial<Record<RelationshipType, number>>;
  lastIndexed: Date | null;
}
