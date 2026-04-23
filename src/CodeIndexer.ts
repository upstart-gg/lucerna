import { createHash } from "node:crypto";
import { glob, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import fastGlob from "fast-glob";
import { TreeSitterChunker } from "./chunker/index.js";

import {
  loadConfig,
  resolveEmbeddingConfig,
  resolveRerankingConfig,
} from "./config.js";
import { IndexLock } from "./IndexLock.js";
import { log } from "./log.js";
import { GraphTraverser } from "./graph/GraphTraverser.js";
import { SymbolResolver } from "./graph/SymbolResolver.js";
import type { ChunkingWithEdgesResult, RawEdge } from "./graph/types.js";
import { Searcher } from "./search/Searcher.js";
import { createStoreBundle } from "./store/factory.js";
import type { GraphStoreInterface } from "./store/GraphStoreInterface.js";
import type { VectorStore } from "./store/VectorStore.js";
import type {
  CodeChunk,
  CodeIndexOptions,
  EmbeddingFunction,
  GraphEdge,
  GraphNeighborhood,
  GraphTraversalOptions,
  IndexEvent,
  IndexStats,
  RelationshipType,
  RepoMapOptions,
  RerankingFunction,
  SearchOptions,
  SearchResult,
  SearchWithContextOptions,
} from "./types.js";
import { Watcher } from "./watcher/Watcher.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Match all files — language detection filters files with no detectable language.
// Files whose language has no custom chunker produce no chunks and are skipped.
const DEFAULT_INCLUDE = ["**/*"];

const DEFAULT_EXCLUDE = [
  // Hidden files and directories — dotfiles are never domain code
  "**/.*",
  "**/.*/**",
  // Common non-hidden build output / dependency dirs
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  // Build output & test coverage (non-dotdir)
  "**/coverage/**",
  "**/__pycache__/**",
  // Lock files — never useful to search, can be very large
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/bun.lockb",
  "**/*.lock",
  "**/*.backup",
  "**/*.bak",
  "**/go.sum",
  "**/go.work.sum",
  // Agent instruction files — contain meta-instructions, not project code
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/GEMINI.md",
  "**/COPILOT.md",
  // Workspace / tooling boilerplate
  "**/pnpm-workspace.yaml",
  "**/pnpm-workspace.yml",
  "**/nx.json",
  "**/turbo.json",
  // Generated / minified
  "**/*.map",
  "**/*.min.js",
  "**/*.min.css",
  // Common binary / media files that produce no language-detected chunks
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.ico",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.7z",
  "**/*.pdf",
  // Lucerna own config
  "**/lucerna.config.js",
  "**/lucerna.config.mjs",
  "**/lucerna.config.cjs",
  "**/lucerna.config.ts",
  // TypeScript / JS toolchain config
  "**/tsconfig.json",
  "**/tsconfig.*.json",
  "**/jsconfig.json",
  // Bundlers / build tools config
  "**/vite.config.{js,ts,mjs,cjs}",
  "**/vitest.config.{js,ts,mjs,cjs}",
  "**/webpack.config.{js,ts,mjs,cjs}",
  "**/rollup.config.{js,ts,mjs,cjs}",
  "**/esbuild.config.{js,ts,mjs,cjs}",
  "**/tsup.config.{js,ts,mjs,cjs}",
  "**/tsdown.config.{js,ts,mjs,cjs}",
  // Test runner config
  "**/jest.config.{js,ts,mjs,cjs,json}",
  "**/playwright.config.{js,ts,mjs,cjs}",
  "**/cypress.config.{js,ts,mjs,cjs}",
  // Linter / formatter config (non-dotfile forms; dotfile forms covered by **/.*  above)
  "**/eslint.config.{js,mjs,cjs,ts}",
  "**/prettier.config.{js,mjs,cjs,ts}",
  "**/biome.json",
  "**/biome.jsonc",
  "**/stylelint.config.{js,mjs,cjs,ts}",
  "**/babel.config.{js,cjs,mjs,ts,json}",
  // CSS / styling config
  "**/tailwind.config.{js,ts,mjs,cjs}",
  "**/postcss.config.{js,ts,mjs,cjs}",
  // Framework config
  "**/next.config.{js,ts,mjs,cjs}",
  "**/nuxt.config.{js,ts,mjs,cjs}",
  "**/remix.config.{js,ts,mjs,cjs}",
  "**/astro.config.{js,ts,mjs,cjs}",
  "**/svelte.config.{js,ts,mjs,cjs}",
  "**/gatsby-config.{js,ts,mjs,cjs}",
  "**/eleventy.config.{js,ts,mjs,cjs}",
  "**/docusaurus.config.{js,ts,mjs,cjs}",
  // Monorepo / workspace tooling
  "**/lerna.json",
  "**/rush.json",
  // Deployment config
  "**/wrangler.toml",
  "**/wrangler.json",
  "**/wrangler.jsonc",
  // Mobile / cross-platform config
  "**/capacitor.config.{json,ts}",
  "**/ionic.config.json",
  "**/angular.json",
  // Commit hooks / git tooling config (non-dotfile forms)
  "**/commitlint.config.{js,mjs,cjs,ts}",
  "**/lint-staged.config.{js,mjs,cjs,ts}",
  // Python project / tool config
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/requirements*.txt",
  "**/tox.ini",
  "**/pytest.ini",
  "**/mypy.ini",
  "**/pyrightconfig.json",
  // Java / Gradle / Maven config
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle",
  "**/settings.gradle.kts",
  // Go module definition
  "**/go.mod",
  // Rust manifest
  "**/Cargo.toml",
  // .NET project / solution files
  "**/*.csproj",
  "**/*.fsproj",
  "**/*.vbproj",
  "**/*.sln",
  "**/global.json",
  "**/nuget.config",
  "**/*.props",
  "**/*.targets",
  // Swift / iOS package / dependency config
  "**/Package.swift",
  "**/Podfile",
  "**/*.podspec",
  // PHP dependency config
  "**/composer.json",
  // Ruby dependency config
  "**/Gemfile",
];

// ---------------------------------------------------------------------------
// CodeIndexer
// ---------------------------------------------------------------------------

/**
 * Main entry point for the lucerna library.
 *
 * Multiple instances can coexist in the same process — each maintains its own
 * isolated LanceDB database scoped to a single project root.
 *
 * @example
 * ```ts
 * const indexer = new CodeIndexer({ projectRoot: '/path/to/project' });
 * await indexer.initialize();
 * await indexer.indexProject();
 * const results = await indexer.search('authentication middleware');
 * await indexer.close();
 * ```
 */
export class CodeIndexer {
  readonly projectRoot: string;
  readonly projectId: string;
  private readonly storageDir: string;
  private readonly include: string[];
  private readonly exclude: string[];
  private embeddingFn: EmbeddingFunction | false;
  private rerankingFn: RerankingFunction | false;
  /** Distinguishes an explicit opt-out (`false`) from "not provided" (`undefined`). */
  private readonly embedderExplicitlyDisabled: boolean;
  private readonly rerankerExplicitlyDisabled: boolean;
  private readonly options: CodeIndexOptions;

  private chunker!: TreeSitterChunker;
  private store!: VectorStore;
  private graphStore!: GraphStoreInterface;
  private searcher!: Searcher;
  private graphTraverser!: GraphTraverser;
  private symbolResolver!: SymbolResolver;
  private watcher: Watcher | null = null;
  private initialized = false;
  private lastIndexed: Date | null = null;

  /** sha1(fileContent) → skip re-indexing unchanged files */
  private fileHashes: Map<string, string> = new Map();

  /**
   * In-memory cache: relPath → chunks in that file.
   * Populated after the first full indexProject() and kept up to date by
   * indexFileInternal() / removeFile(). Used by loadAllChunks() to avoid
   * a full DB scan on every watcher-triggered re-index.
   */
  private cachedChunksByFile: Map<string, CodeChunk[]> = new Map();

  /** Prevents concurrent indexProject() calls from corrupting state. */
  private indexingInProgress = false;

  /** Timer used to batch saveFileHashes() writes in the watcher path. */
  private saveHashesTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer used to debounce store.optimize() calls triggered by watcher events. */
  private optimizeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cross-process exclusive lock: the holder is the only process that indexes. */
  private lock!: IndexLock;
  private _isLeader = false;
  /** setInterval handle used by follower processes to poll for leadership. */
  private leaderPollInterval: ReturnType<typeof setInterval> | null = null;

  /** True if this process holds the indexing lock (leader). Read-only externally. */
  get isLeader(): boolean {
    return this._isLeader;
  }

  constructor(options: CodeIndexOptions) {
    this.options = options;
    this.projectRoot = resolve(options.projectRoot);
    this.projectId = options.projectId ?? hashProjectRoot(this.projectRoot);
    this.storageDir = options.storageDir
      ? resolve(options.storageDir)
      : resolve(this.projectRoot, ".lucerna");
    this.include = options.include ?? DEFAULT_INCLUDE;
    this.exclude = [
      ...DEFAULT_EXCLUDE,
      // Always exclude the storage dir itself
      `${this.storageDir}/**`,
    ];
    if (options.exclude) {
      this.exclude.push(...options.exclude);
    }

    // Resolve embedding function.
    //   - explicit `false` → lexical-only, never auto-load
    //   - an EmbeddingFunction instance → use it directly
    //   - undefined → leave as `false` for now; initialize() will auto-load
    //     from `lucerna.config.ts` if one exists under projectRoot.
    this.embedderExplicitlyDisabled = options.embeddingFunction === false;
    this.embeddingFn = options.embeddingFunction
      ? options.embeddingFunction
      : false;

    // Resolve reranking function (same tri-state semantics).
    this.rerankerExplicitlyDisabled = options.rerankingFunction === false;
    this.rerankingFn = options.rerankingFunction
      ? options.rerankingFunction
      : false;
  }

  /**
   * Initialize the indexer: load tree-sitter grammars, open the LanceDB store,
   * and set up the knowledge-graph store.
   * Must be called before any other methods.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.storageDir, { recursive: true });

    this.lock = new IndexLock(this.storageDir);
    this._isLeader = await this.lock.tryAcquire();
    process.stderr.write(
      `[lucerna] ${this._isLeader ? "Leader" : "Follower"} (PID ${process.pid})\n`,
    );

    // Auto-load `lucerna.config.ts` when the caller didn't pass an explicit
    // embedding/reranking function. This keeps programmatic usage aligned
    // with CLI / MCP: any of the three entry points sees the same config.
    // Explicit `false` (lexical-only) is respected and never triggers a load.
    if (
      this.options.embeddingFunction === undefined &&
      !this.embedderExplicitlyDisabled
    ) {
      const { config: cfg } = await loadConfig(this.projectRoot);
      if (cfg.embedding !== undefined) {
        const resolved = await resolveEmbeddingConfig(cfg.embedding);
        if (resolved) this.embeddingFn = resolved;
      }
      if (
        this.options.rerankingFunction === undefined &&
        !this.rerankerExplicitlyDisabled &&
        cfg.reranking !== undefined
      ) {
        const resolvedR = await resolveRerankingConfig(cfg.reranking);
        if (resolvedR) this.rerankingFn = resolvedR;
      }
    }

    // Auto-clear stale index when the embedding model or dimensions change.
    // Skipped when no embedding function is configured (e.g. `stats --no-semantic`):
    // without a target dim/model we can't meaningfully compare, and defaulting would
    // wipe a valid index built by a semantic run.
    const metaPath = join(this.storageDir, "index-meta.json");
    let existingMeta: { modelId?: string; dimensions: number } | null = null;
    try {
      const raw = await readFile(metaPath, "utf8");
      existingMeta = JSON.parse(raw) as {
        modelId?: string;
        dimensions: number;
      };
    } catch {
      // No meta file yet — fresh index, nothing to clear
    }

    if (this.embeddingFn !== false && existingMeta) {
      const currentDimensions = this.embeddingFn.dimensions;
      const currentModelId = this.embeddingFn.modelId;
      const dimChanged = existingMeta.dimensions !== currentDimensions;
      const modelChanged =
        existingMeta.modelId !== undefined &&
        currentModelId !== undefined &&
        existingMeta.modelId !== currentModelId;
      if (dimChanged || modelChanged) {
        const reason = dimChanged
          ? `dimensions changed (${existingMeta.dimensions} → ${currentDimensions})`
          : `model changed ("${existingMeta.modelId}" → "${currentModelId}")`;
        log.warn(
          `[lucerna] Embedding ${reason} — clearing index for full reindex.`,
        );
        await rm(join(this.storageDir, "lance"), {
          recursive: true,
          force: true,
        });
        await rm(join(this.storageDir, "sqlite"), {
          recursive: true,
          force: true,
        });
        await rm(metaPath, { force: true });
        await rm(join(this.storageDir, "file-hashes.json"), { force: true });
        existingMeta = null;
      }
    }

    this.chunker = new TreeSitterChunker({
      ...(this.options.maxChunkTokens !== undefined
        ? { maxChunkTokens: this.options.maxChunkTokens }
        : {}),
    });
    await this.chunker.initialize();

    // When no embedding function is configured, reuse the existing index's
    // dims/model so read-only commands (stats, lexical search) can open a
    // store built by a prior semantic run. When neither an embedder nor a
    // pre-existing index is present, `dimensions` is left undefined — the
    // store will skip creating its vector table entirely, which is what
    // we want for a lexical-only session on a fresh dir.
    const dimensions =
      this.embeddingFn !== false
        ? this.embeddingFn.dimensions
        : existingMeta?.dimensions;
    const modelId =
      this.embeddingFn !== false
        ? this.embeddingFn.modelId
        : existingMeta?.modelId;

    const bundle = await createStoreBundle({
      backend: this.options.vectorStore ?? "sqlite",
      storageDir: this.storageDir,
      ...(dimensions !== undefined ? { dimensions } : {}),
      modelId,
    });
    this.store = bundle.vectorStore;
    this.graphStore = bundle.graphStore;

    this.searcher = new Searcher(
      this.store,
      this.embeddingFn,
      this.rerankingFn,
    );
    this.symbolResolver = new SymbolResolver(this.projectRoot);
    this.graphTraverser = new GraphTraverser(this.graphStore, this.store);

    // Merge .gitignore patterns (all depths) into exclude list so both
    // glob (indexing) and Watcher (watch mode) respect gitignore.
    const gitignoreExcludes = await loadAllGitignorePatterns(this.projectRoot);
    this.exclude.push(...gitignoreExcludes);

    this.initialized = true;

    // Load persisted file hashes for change detection
    await this.loadFileHashes();

    // Pre-warm the embedding model so the first indexProject/search call
    // doesn't pay the model cold-start cost
    if (this.embeddingFn !== false) {
      await this.embeddingFn.warmup?.();
    }

    if (this.options.watch) {
      await this.startWatching();
    }
  }

  /**
   * Index all files in the project matching the configured include/exclude patterns.
   * Files whose content has not changed since the last run are skipped automatically.
   * Also extracts and resolves knowledge-graph edges for all changed files.
   *
   * Throws if called while a previous indexProject() is still running.
   */
  async indexProject(): Promise<IndexStats> {
    this.assertInitialized();
    if (!this._isLeader) {
      return {
        projectId: this.projectId,
        projectRoot: this.projectRoot,
        totalFiles: 0,
        totalChunks: 0,
        totalEdges: 0,
        byLanguage: {},
        byType: {},
        byEdgeType: {},
        lastIndexed: this.lastIndexed,
      };
    }
    if (this.indexingInProgress) {
      throw new Error(
        "CodeIndexer.indexProject() is already in progress. Await the previous call before calling again.",
      );
    }
    this.indexingInProgress = true;

    // Accumulates raw edges from all batches for a single graph-resolution pass
    const allRawEdges: RawEdge[] = [];
    let totalChunks = 0;
    let anyChanges = false;

    // Process a batch of changed files: chunk → embed → store → emit per file
    const processBatch = async (
      batch: Array<{ absPath: string; relPath: string; hash: string }>,
    ): Promise<void> => {
      const fileResults = (
        await Promise.all(
          batch.map(async ({ absPath, relPath, hash }) => {
            const result = await this.chunker.chunkFileWithEdges(
              absPath,
              this.projectId,
            );
            if (result.chunks.length === 0) return null;
            const { chunks, rawEdges } = this.normalizeResult(result, relPath);
            return { relPath, hash, chunks, rawEdges };
          }),
        )
      ).filter((r): r is NonNullable<typeof r> => r !== null);

      const batchChunks = fileResults.flatMap((f) => f.chunks);
      let batchVectors: number[][];
      if (this.embeddingFn !== false && batchChunks.length > 0) {
        batchVectors = await this.embeddingFn.generate(
          batchChunks.map((c) => c.contextContent),
        );
      } else {
        batchVectors = batchChunks.map(() => []);
      }

      let vectorOffset = 0;
      for (const { relPath, hash, chunks, rawEdges } of fileResults) {
        const vectors = batchVectors.slice(
          vectorOffset,
          vectorOffset + chunks.length,
        );
        vectorOffset += chunks.length;

        await this.store.deleteByFile(relPath);
        await this.store.upsert(chunks, vectors);
        await this.graphStore.deleteEdgesByFile(relPath);

        this.cachedChunksByFile.set(relPath, chunks);
        this.fileHashes.set(relPath, hash);
        totalChunks += chunks.length;
        allRawEdges.push(...rawEdges);
        this.emit({
          type: "indexed",
          filePath: relPath,
          chunksAffected: chunks.length,
        });
      }
    };

    try {
      const BATCH_SIZE = 50;
      let batch: Array<{ absPath: string; relPath: string; hash: string }> = [];

      // Stream files via native glob — hash each on arrival, skip unchanged
      for await (const relPath of glob(this.include, {
        cwd: this.projectRoot,
        exclude: this.exclude,
      })) {
        const absPath = join(this.projectRoot, relPath);
        const fileStat = await stat(absPath).catch(() => null);
        if (!fileStat?.isFile()) continue;
        const hash = await hashFile(absPath);
        if (this.fileHashes.get(relPath) === hash) continue;

        anyChanges = true;
        batch.push({ absPath, relPath, hash });
        if (batch.length >= BATCH_SIZE) {
          await processBatch(batch);
          batch = [];
        }
      }

      if (batch.length > 0) await processBatch(batch);

      if (!anyChanges) {
        this.lastIndexed = new Date();
        return this.getStats();
      }

      // Graph resolution — single pass after all batches.
      // loadAllChunks() uses the in-memory cache updated above; on the first
      // run it is primed from the DB to cover unchanged files from prior sessions.
      if (allRawEdges.length > 0) {
        const allIndexedChunks = await this.loadAllChunks();
        const resolvedEdges = await this.symbolResolver.resolveAll(
          allRawEdges,
          allIndexedChunks,
          this.projectId,
        );
        if (resolvedEdges.length > 0) {
          await this.graphStore.upsertEdges(resolvedEdges);
        }
      }

      await this.saveFileHashes();
      // Compact LanceDB indexes now so the first search pays no setup cost.
      // Cancel any pending debounced optimize — this explicit call supersedes it.
      if (this.optimizeTimer !== null) {
        clearTimeout(this.optimizeTimer);
        this.optimizeTimer = null;
      }
      await this.store.optimize?.({ vacuum: true });
      this.lastIndexed = new Date();
      this.emit({
        type: "indexed",
        filePath: this.projectRoot,
        chunksAffected: totalChunks,
      });

      return this.getStats();
    } finally {
      this.indexingInProgress = false;
    }
  }

  /**
   * Index (or re-index) a single file.
   * Pass an absolute path or a path relative to projectRoot.
   */
  async indexFile(filePath: string): Promise<void> {
    this.assertInitialized();
    const absPath = resolve(this.projectRoot, filePath);
    await this.indexFileInternal(absPath);
  }

  /**
   * Remove all chunks and edges for a given file from the index.
   */
  async removeFile(filePath: string): Promise<void> {
    this.assertInitialized();
    const absPath = resolve(this.projectRoot, filePath);
    const relPath = relative(this.projectRoot, absPath);
    // Fetch chunk IDs before deletion so we can cascade to incoming edges
    const chunks = await this.store.getChunksByFile(relPath);
    const chunkIds = chunks.map((c) => c.id);
    await this.store.deleteByFile(relPath);
    await this.graphStore.deleteEdgesByFile(relPath);
    if (chunkIds.length > 0) {
      await this.graphStore.deleteEdgesByTargetChunks(chunkIds);
    }
    this.cachedChunksByFile.delete(relPath);
    this.fileHashes.delete(relPath);
    await this.saveFileHashes();
    this.scheduleOptimize();
    this.emit({ type: "removed", filePath: relPath });
  }

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  async startWatching(): Promise<void> {
    this.assertInitialized();
    if (this._isLeader) {
      await this.startLeaderWatching();
    } else {
      this.startLeadershipPoll();
    }
  }

  private async startLeaderWatching(): Promise<void> {
    if (this.watcher) return;

    this.watcher = new Watcher({
      projectRoot: this.projectRoot,
      include: this.include,
      exclude: this.exclude,
      debounce: this.options.watchDebounce ?? 500,
      onAdd: (path) => this.indexFileInternal(path).then(() => {}),
      onChange: (path) => this.indexFileInternal(path).then(() => {}),
      onRemove: (path) => this.removeFile(path),
      ...(this.options.onIndexed !== undefined
        ? { onEvent: this.options.onIndexed }
        : {}),
    });

    await this.watcher.start();
  }

  private startLeadershipPoll(): void {
    this.leaderPollInterval = setInterval(() => {
      void (async () => {
        const acquired = await this.lock.tryAcquire();
        if (!acquired) return;
        this._isLeader = true;
        if (this.leaderPollInterval !== null) {
          clearInterval(this.leaderPollInterval);
          this.leaderPollInterval = null;
        }
        process.stderr.write(
          "[lucerna] Claimed leadership. Re-indexing and starting watcher…\n",
        );
        await this.indexProject();
        await this.startLeaderWatching();
      })();
    }, this.options.leaderPollMs ?? 10_000);
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Hybrid search (semantic + lexical combined via RRF).
   * Falls back to lexical-only when no embedding function is configured.
   */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    this.assertInitialized();
    return this.searcher.search(query, options);
  }

  /** Vector / semantic search only. Requires an embedding function. */
  async searchSemantic(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    this.assertInitialized();
    return this.searcher.searchSemantic(query, options);
  }

  /** BM25 / full-text lexical search only. */
  async searchLexical(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    this.assertInitialized();
    return this.searcher.searchLexical(query, options);
  }

  /**
   * Hybrid search followed by graph-based context expansion.
   *
   * Finds the top matching chunks via search, then expands each result by
   * traversing its graph neighbourhood (callers, callees, dependencies, etc.)
   * and adds those neighbours to the result set with a discounted score.
   *
   * Use `graphDepth` to control how many hops to follow (default: 1).
   * Use `contextScoreDiscount` to control the neighbour score multiplier (default: 0.7).
   */
  async searchWithContext(
    query: string,
    options: SearchWithContextOptions = {},
  ): Promise<SearchResult[]> {
    this.assertInitialized();

    const {
      graphDepth = 1,
      graphRelationTypes,
      contextScoreDiscount = 0.7,
      ...searchOpts
    } = options;
    const limit = searchOpts.limit ?? 10;

    const baseResults = await this.searcher.search(query, {
      ...searchOpts,
      limit,
    });

    if (graphDepth === 0 || baseResults.length === 0) {
      return baseResults;
    }

    const expanded = new Map<string, SearchResult>();
    for (const result of baseResults) {
      expanded.set(result.chunk.id, result);
    }

    for (const result of baseResults) {
      if (expanded.size >= limit * 3) break; // cap total candidates
      const neighbourhood = await this.graphTraverser.getNeighborhood(
        result.chunk.id,
        {
          depth: graphDepth,
          ...(graphRelationTypes !== undefined
            ? { relationTypes: graphRelationTypes }
            : {}),
          limit: 5,
        },
      );
      for (const { chunk } of neighbourhood.edges) {
        if (!expanded.has(chunk.id)) {
          expanded.set(chunk.id, {
            chunk,
            score: result.score * contextScoreDiscount,
            matchType: result.matchType,
          });
        }
      }
    }

    return [...expanded.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Graph traversal API
  // ---------------------------------------------------------------------------

  /**
   * Returns the knowledge-graph neighbourhood of a chunk (BFS up to `depth` hops).
   */
  async getNeighborhood(
    chunkId: string,
    options?: GraphTraversalOptions,
  ): Promise<GraphNeighborhood> {
    this.assertInitialized();
    return this.graphTraverser.getNeighborhood(chunkId, options);
  }

  /** Returns all chunks that directly call the chunk with the given id. */
  async getCallers(chunkId: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    return this.graphTraverser.getCallers(chunkId);
  }

  /** Returns all chunks that the chunk with the given id calls. */
  async getCallees(chunkId: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    return this.graphTraverser.getCallees(chunkId);
  }

  /** Returns all chunks that implement or extend the chunk with the given id. */
  async getImplementors(chunkId: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    return this.graphTraverser.getImplementors(chunkId);
  }

  /** Returns all chunks that the chunk with the given id extends or implements. */
  async getSuperTypes(chunkId: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    return this.graphTraverser.getSuperTypes(chunkId);
  }

  /** Returns all chunks that reference (USES) the chunk with the given id. */
  async getUsages(chunkId: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    return this.graphTraverser.getUsages(chunkId);
  }

  /** Returns the import chunks of files that the given file imports. */
  async getDependencies(filePath: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    const relPath = relative(
      this.projectRoot,
      resolve(this.projectRoot, filePath),
    );
    return this.graphTraverser.getDependencies(relPath, this.store);
  }

  /** Returns the import chunks of files that import the given file. */
  async getDependents(filePath: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    const relPath = relative(
      this.projectRoot,
      resolve(this.projectRoot, filePath),
    );
    return this.graphTraverser.getDependents(relPath, this.store);
  }

  /** Returns all outgoing edges from a chunk. */
  async getEdgesFrom(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    this.assertInitialized();
    return this.graphStore.getOutgoing(chunkId, types);
  }

  /** Returns all incoming edges to a chunk. */
  async getEdgesTo(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    this.assertInitialized();
    return this.graphStore.getIncoming(chunkId, types);
  }

  // ---------------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------------

  async getStats(): Promise<IndexStats> {
    this.assertInitialized();
    const files = await this.store.listFiles();
    const total = await this.store.count();
    const totalEdges = await this.graphStore.countEdges();
    const [byEdgeType, byLanguage, byType] = await Promise.all([
      this.graphStore.countByType(),
      this.store.countByLanguage(),
      this.store.countByType(),
    ]);

    return {
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      totalFiles: files.length,
      totalChunks: total,
      totalEdges,
      byLanguage,
      byType,
      byEdgeType,
      lastIndexed: this.lastIndexed,
    };
  }

  /**
   * Returns a concise map of all indexed files and their top-level symbols —
   * similar to Aider's repo-map. Useful for giving agents a structural overview
   * of the codebase before issuing search queries.
   *
   * @example
   * ```ts
   * const map = await indexer.getRepoMap();
   * // src/search/Searcher.ts
   * //   class Searcher (18-112)
   * //   function reciprocalRankFusion (118-150)
   * ```
   */
  async getRepoMap(options: RepoMapOptions = {}): Promise<string> {
    this.assertInitialized();
    const { maxFiles, types, format = "text" } = options;

    let symbols = await this.store.getAllSymbols();

    // Filter to requested types if provided
    if (types && types.length > 0) {
      const typeSet = new Set<string>(types);
      symbols = symbols.filter((s) => typeSet.has(s.type));
    }

    // Group by file, sort symbols within each file by startLine
    const byFile = new Map<
      string,
      Array<{ type: string; name: string; startLine: number; endLine: number }>
    >();
    for (const sym of symbols) {
      if (!sym.name) continue; // skip anonymous chunks
      let list = byFile.get(sym.filePath);
      if (!list) {
        list = [];
        byFile.set(sym.filePath, list);
      }
      list.push({
        type: sym.type,
        name: sym.name,
        startLine: sym.startLine,
        endLine: sym.endLine,
      });
    }
    for (const list of byFile.values()) {
      list.sort((a, b) => a.startLine - b.startLine);
    }

    // Sort files alphabetically, optionally cap by maxFiles (largest symbol count first)
    let files = [...byFile.keys()].sort();
    if (maxFiles !== undefined) {
      files = files
        .sort(
          (a, b) => (byFile.get(b)?.length ?? 0) - (byFile.get(a)?.length ?? 0),
        )
        .slice(0, maxFiles);
    }

    if (format === "json") {
      const json = files.map((f) => ({
        file: f,
        symbols: byFile.get(f) ?? [],
      }));
      return JSON.stringify(json, null, 2);
    }

    // Text format
    const lines: string[] = [];
    for (const file of files) {
      lines.push(file);
      for (const sym of byFile.get(file) ?? []) {
        lines.push(
          `  ${sym.type} ${sym.name} (${sym.startLine}-${sym.endLine})`,
        );
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  async listFiles(): Promise<string[]> {
    this.assertInitialized();
    return this.store.listFiles();
  }

  async getChunks(filePath: string): Promise<CodeChunk[]> {
    this.assertInitialized();
    const relPath = relative(
      this.projectRoot,
      resolve(this.projectRoot, filePath),
    );
    return this.store.getChunksByFile(relPath);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.leaderPollInterval !== null) {
      clearInterval(this.leaderPollInterval);
      this.leaderPollInterval = null;
    }
    // Flush any pending hash saves before closing
    if (this.saveHashesTimer !== null) {
      clearTimeout(this.saveHashesTimer);
      this.saveHashesTimer = null;
      await this.saveFileHashes();
    }
    // Drop any pending optimize — advisory; the next session will optimize again
    if (this.optimizeTimer !== null) {
      clearTimeout(this.optimizeTimer);
      this.optimizeTimer = null;
    }
    await this.stopWatching();
    await this.lock?.release();
    if (this.store) await this.store.close();
    if (this.graphStore) await this.graphStore.close();
    if (this.chunker) await this.chunker.close();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async indexFileInternal(absPath: string): Promise<number> {
    try {
      // Verify file still exists
      try {
        await stat(absPath);
      } catch {
        return 0;
      }

      const relPath = relative(this.projectRoot, absPath);

      // Skip files whose content hasn't changed
      const hash = await hashFile(absPath);
      if (this.fileHashes.get(relPath) === hash) {
        return 0;
      }

      const result = await this.chunker.chunkFileWithEdges(
        absPath,
        this.projectId,
      );
      if (result.chunks.length === 0) return 0;

      const { chunks, rawEdges } = this.normalizeResult(result, relPath);

      let vectors: number[][];
      if (this.embeddingFn !== false) {
        vectors = await this.embeddingFn.generate(
          chunks.map((c) => c.contextContent),
        );
      } else {
        vectors = chunks.map(() => []);
      }

      await this.store.deleteByFile(relPath);
      await this.store.upsert(chunks, vectors);
      await this.graphStore.deleteEdgesByFile(relPath);

      // Update in-memory cache for this file before resolving edges so that
      // cross-file resolution sees the freshest state.
      this.cachedChunksByFile.set(relPath, chunks);

      if (rawEdges.length > 0) {
        const allIndexedChunks = await this.loadAllChunks();
        const resolvedEdges = await this.symbolResolver.resolveAll(
          rawEdges,
          allIndexedChunks,
          this.projectId,
        );
        if (resolvedEdges.length > 0) {
          await this.graphStore.upsertEdges(resolvedEdges);
        }
      }

      this.fileHashes.set(relPath, hash);
      // Debounce disk writes: many rapid watcher events should not hammer the FS
      this.scheduleSaveFileHashes();
      // Debounce LanceDB compaction similarly — bursts of watcher events would
      // otherwise trigger an optimize() per file.
      this.scheduleOptimize();

      this.emit({
        type: "indexed",
        filePath: relPath,
        chunksAffected: chunks.length,
      });
      return chunks.length;
    } catch (err) {
      const relPath = relative(this.projectRoot, absPath);
      this.emit({
        type: "error",
        filePath: relPath,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return 0;
    }
  }

  /**
   * Normalises a raw chunking result: converts absolute filePaths to relative,
   * rebuilds stable chunk IDs, and remaps raw edge source/target IDs accordingly.
   * Extracted to eliminate duplication between indexProject() and indexFileInternal().
   */
  private normalizeResult(
    result: ChunkingWithEdgesResult,
    relPath: string,
  ): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
    const oldToNewId = new Map<string, string>();
    for (const chunk of result.chunks) {
      const oldId = chunk.id;
      chunk.filePath = relPath;
      chunk.id = stableChunkId(this.projectId, relPath, chunk.startLine);
      oldToNewId.set(oldId, chunk.id);
    }

    const rawEdges: RawEdge[] = result.rawEdges.map((edge) => ({
      ...edge,
      sourceChunkId: oldToNewId.get(edge.sourceChunkId) ?? edge.sourceChunkId,
      sourceFilePath: relPath,
      targetSymbol:
        edge.type === "DEFINES"
          ? (oldToNewId.get(edge.targetSymbol) ?? edge.targetSymbol)
          : edge.targetSymbol,
    }));

    return { chunks: result.chunks, rawEdges };
  }

  /**
   * Returns all currently indexed chunks.
   * Uses the in-memory cache when populated (watcher path — O(1) after first index).
   * On the first call (empty cache) loads from DB and populates the cache.
   */
  private async loadAllChunks(): Promise<CodeChunk[]> {
    if (this.cachedChunksByFile.size > 0) {
      return Array.from(this.cachedChunksByFile.values()).flat();
    }
    // First time: load from DB concurrently and prime the cache
    const filePaths = await this.store.listFiles();
    const chunkArrays = await Promise.all(
      filePaths.map((fp) => this.store.getChunksByFile(fp)),
    );
    for (let i = 0; i < filePaths.length; i++) {
      const fp = filePaths[i];
      const arr = chunkArrays[i];
      if (fp !== undefined && arr !== undefined) {
        this.cachedChunksByFile.set(fp, arr);
      }
    }
    return chunkArrays.flat();
  }

  /** Schedule a debounced write of file hashes (2 s after last change). */
  private scheduleSaveFileHashes(): void {
    if (this.saveHashesTimer !== null) return;
    this.saveHashesTimer = setTimeout(() => {
      this.saveHashesTimer = null;
      this.saveFileHashes().catch(() => {});
    }, 2_000);
  }

  /** Schedule a debounced store.optimize() call (5 s after the latest watcher event). */
  private scheduleOptimize(): void {
    if (this.optimizeTimer !== null) return;
    this.optimizeTimer = setTimeout(() => {
      this.optimizeTimer = null;
      this.store.optimize?.().catch(() => {});
    }, 5_000);
  }

  private get hashFilePath(): string {
    return join(this.storageDir, "file-hashes.json");
  }

  private async loadFileHashes(): Promise<void> {
    try {
      const data = await readFile(this.hashFilePath, "utf8");
      const obj = JSON.parse(data) as Record<string, string>;
      this.fileHashes = new Map(Object.entries(obj));
      // file-hashes.json is rewritten on every successful index, so its mtime
      // is a good proxy for "last indexed" across process boundaries.
      const s = await stat(this.hashFilePath).catch(() => null);
      if (s) this.lastIndexed = s.mtime;
    } catch {
      this.fileHashes = new Map();
    }
  }

  private async saveFileHashes(): Promise<void> {
    const obj = Object.fromEntries(this.fileHashes);
    await writeFile(this.hashFilePath, JSON.stringify(obj));
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "CodeIndexer.initialize() must be called before using this instance.",
      );
    }
  }

  private emit(event: IndexEvent): void {
    this.options.onIndexed?.(event);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hashProjectRoot(projectRoot: string): string {
  return createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);
}

async function hashFile(absPath: string): Promise<string> {
  const content = await readFile(absPath);
  return createHash("sha1").update(content).digest("hex");
}

function stableChunkId(
  projectId: string,
  filePath: string,
  startLine: number,
): string {
  return createHash("sha1")
    .update(`${projectId}:${filePath}:${startLine}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Discover all .gitignore files under root and convert their patterns into
 * fast-glob-compatible exclude globs, resolving each pattern relative to the
 * directory that contains the .gitignore file.
 *
 * Rules applied:
 *  - Blank lines and # comments are skipped.
 *  - Negation lines starting with '!' are skipped (inversion is complex).
 *  - A pattern starting with '/' is anchored to its directory: the '/' is stripped
 *    and the pattern is prefixed with the directory path.
 *  - A pattern with no '/' (or only a trailing '/') matches anywhere under its
 *    directory, so '**\/' is prepended (within the directory prefix).
 *  - A pattern ending with '/' denotes a directory; '**' is appended so all
 *    descendants are excluded.
 */
async function loadAllGitignorePatterns(root: string): Promise<string[]> {
  const gitignoreFiles = await fastGlob("**/.gitignore", {
    cwd: root,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
  });

  const allPatterns: string[] = [];

  for (const relGitignore of gitignoreFiles) {
    const absGitignore = join(root, relGitignore);
    // Directory containing this .gitignore, relative to root (e.g. "" or "packages/server")
    const relDir = dirname(relGitignore) === "." ? "" : dirname(relGitignore);

    let content: string;
    try {
      content = await readFile(absGitignore, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;

      let pattern = line;
      const anchored = pattern.startsWith("/");
      if (anchored) pattern = pattern.slice(1);

      const isDir = pattern.endsWith("/");
      if (isDir) pattern = pattern.slice(0, -1);

      // Determine whether the pattern itself contains a slash (making it
      // already directory-relative) or should match anywhere in the subtree.
      const hasSlash = pattern.includes("/");

      let globPattern: string;
      if (relDir) {
        if (anchored || hasSlash) {
          // Anchored to this dir, or already path-scoped
          globPattern = `${relDir}/${pattern}`;
        } else {
          // Matches anywhere under this dir
          globPattern = `${relDir}/**/${pattern}`;
        }
      } else {
        if (anchored || hasSlash) {
          globPattern = pattern;
        } else {
          globPattern = `**/${pattern}`;
        }
      }

      if (isDir) globPattern += "/**";

      allPatterns.push(globPattern);
    }
  }

  // Deduplicate
  return [...new Set(allPatterns)];
}
