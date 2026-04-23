import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import type {
  ChunkType,
  CodeChunk,
  Language,
  SearchOptions,
  SearchResult,
} from "../types.js";
import { log } from "../log.js";
import { expandIdentifiers } from "./identifierExpansion.js";
import type { VectorStore } from "./VectorStore.js";

// Dynamically imported so `@lancedb/lancedb` remains an optional dep — users
// who pick the SQLite backend don't need the native LanceDB binary installed.
type LanceDB = typeof import("@lancedb/lancedb");
let lancedbModule: LanceDB | null = null;
async function loadLanceDB(): Promise<LanceDB> {
  if (lancedbModule) return lancedbModule;
  try {
    lancedbModule = await import("@lancedb/lancedb");
    return lancedbModule;
  } catch (err) {
    throw new Error(
      `The "@lancedb/lancedb" package is required for the lancedb backend but could not be loaded. ` +
        `Install it with 'pnpm add @lancedb/lancedb' (or run 'lucerna install' and pick lancedb). ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

interface ChunkRow extends Record<string, unknown> {
  id: string;
  projectId: string;
  filePath: string;
  language: string;
  type: string;
  name: string;
  content: string;
  contextContent: string;
  startLine: number;
  endLine: number;
  metadata: string; // JSON string
  vector: number[];
  searchContent: string; // identifier-expanded content for code-aware BM25
}

const DEFAULT_RRF_K = 45; // tuned for code retrieval (doc-IR default is 60)

// ---------------------------------------------------------------------------
// LanceDBStore
// ---------------------------------------------------------------------------

export interface LanceDBStoreOptions {
  /** Directory where the LanceDB files are stored */
  storageDir: string;
  /**
   * Dimensionality of the embedding vectors. Omit for lexical-only operation
   * on a fresh index — the "chunks" table won't be created, and upsert will
   * skip vector writes. If an existing index is found, the stored dim is
   * adopted transparently.
   */
  dimensions?: number | undefined;
  /** Optional model identifier — persisted to index-meta.json to detect model changes on re-open */
  modelId?: string | undefined;
}

/**
 * VectorStore implementation backed by LanceDB.
 *
 * - One LanceDB database per projectId (stored in `storageDir/lance/`)
 * - Table name: "chunks"
 * - Supports both vector search and full-text (BM25) search
 */
export class LanceDBStore implements VectorStore {
  private readonly storageDir: string;
  private readonly metaFilePath: string;
  /**
   * Effective vector dim. `undefined` means: no embedder configured AND no
   * pre-existing index — skip table creation and skip vector writes. If an
   * existing index is opened, its stored dim is adopted here.
   */
  private dimensions: number | undefined;
  private readonly modelId: string | undefined;
  private db: Connection | null = null;
  private table: Table | null = null;
  private ftsIndexed = false;
  private ftsIndexExists = false; // tracks whether an FTS index has been created at all
  private vectorIndexed = false;
  private searchContentAvailable = true;

  constructor(options: LanceDBStoreOptions) {
    this.storageDir = join(options.storageDir, "lance");
    this.metaFilePath = join(options.storageDir, "index-meta.json");
    this.dimensions = options.dimensions;
    this.modelId = options.modelId;
  }

  async initialize(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.storageDir);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes("chunks")) {
      this.table = await this.db.openTable("chunks");
      // Guard against silent vector space corruption when the embedding model
      // changes. If the stored vector dimension differs from the configured one,
      // search results would be garbage and upserts would fail at the LanceDB
      // level with an unhelpful schema error.
      const storedDim = await this.getStoredDimensions();
      if (storedDim !== null) {
        if (this.dimensions === undefined) {
          // Lexical-only session opening an index built by a prior semantic
          // run — adopt the stored dim so searches line up.
          this.dimensions = storedDim;
        } else if (storedDim !== this.dimensions) {
          throw new Error(
            `Embedding dimension mismatch: the index was built with ${storedDim}-dimensional vectors ` +
              `but the current model produces ${this.dimensions}-dimensional vectors. ` +
              `Run 'lucerna clear' then 'lucerna index' to rebuild the index with the new model.`,
          );
        }
      }
      // Warn if the model identifier changed (soft check — dimensions may still match
      // if two models happen to share the same output size, but embeddings are incompatible)
      const meta = await this.readMeta();
      if (meta?.modelId && this.modelId && meta.modelId !== this.modelId) {
        log.warn(
          `[lucerna] Embedding model changed: index was built with "${meta.modelId}" ` +
            `but the current model is "${this.modelId}". ` +
            `Search quality may be degraded. Run 'lucerna clear' then 'lucerna index' to rebuild.`,
        );
      }
      // Detect whether the index was built with the searchContent column (code-aware BM25).
      // Older indexes won't have it — fall back to the plain content column for FTS.
      const sample = await this.table.query().limit(1).toArray();
      this.searchContentAvailable =
        sample.length === 0 || "searchContent" in (sample[0] ?? {});
      if (!this.searchContentAvailable) {
        log.warn(
          "[lucerna] Index was built without code-aware BM25 tokenization. " +
            "Run `lucerna clear` then `lucerna index` to enable identifier expansion.",
        );
      }
    } else if (this.dimensions !== undefined) {
      // Create table with an empty schema row, then delete it
      const emptyRow: ChunkRow = {
        id: "__init__",
        projectId: "",
        filePath: "",
        language: "",
        type: "",
        name: "",
        content: "",
        contextContent: "",
        startLine: 0,
        endLine: 0,
        metadata: "{}",
        vector: new Array(this.dimensions).fill(0) as number[],
        searchContent: "",
      };
      this.table = await this.db.createTable("chunks", [emptyRow]);
      await this.table.delete('id = "__init__"');
      await this.writeMeta();
    }
    // else: no embedder AND no existing index — leave this.table null. All
    // read/write methods short-circuit when the table is absent, so lexical
    // search on an empty store returns [] (the Searcher handles that fine).
  }

  async upsert(chunks: CodeChunk[], vectors: number[][]): Promise<void> {
    if (!this.table) {
      // No chunks table means no embedder was configured AND no prior index
      // existed. LanceDB's schema requires a vector column with a known dim,
      // so we can't lazily create the table without one. Surface this as a
      // clear actionable error rather than a cryptic "not initialized".
      throw new Error(
        "LanceDBStore: cannot index without an embedder. Configure `embedding` in lucerna.config.ts " +
          "or switch to the sqlite backend which supports lexical-only operation on fresh stores.",
      );
    }
    if (chunks.length === 0) return;
    if (this.dimensions === undefined) {
      // Shouldn't reach here — initialize() adopts storedDim when table exists.
      throw new Error("LanceDBStore: dimension not resolved before upsert");
    }
    const dims = this.dimensions;

    // Delete existing rows for these IDs first (upsert = delete + insert)
    const ids = chunks.map((c) => sqlStr(c.id)).join(", ");
    await this.table.delete(`id IN (${ids})`);

    const rows: ChunkRow[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      projectId: chunk.projectId,
      filePath: chunk.filePath,
      language: chunk.language,
      type: chunk.type,
      name: chunk.name ?? "",
      content: chunk.content,
      contextContent: chunk.contextContent,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      metadata: JSON.stringify(chunk.metadata),
      vector: vectors[i] ?? new Array(dims).fill(0),
      searchContent: expandIdentifiers(
        chunk.name ? `${chunk.content} ${chunk.name}` : chunk.content,
      ),
    }));

    await this.table.add(rows);

    // Write metadata on first upsert for indexes created before model tracking was added
    const meta = await this.readMeta();
    if (!meta) await this.writeMeta();

    // Invalidate index flags so they get rebuilt on next search
    this.ftsIndexed = false;
    this.vectorIndexed = false;
  }

  async delete(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    const idList = ids.map(sqlStr).join(", ");
    await this.table.delete(`id IN (${idList})`);
    this.ftsIndexed = false;
    this.vectorIndexed = false;
  }

  async deleteByFile(filePath: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`filePath = ${sqlStr(filePath)}`);
    this.ftsIndexed = false;
    this.vectorIndexed = false;
  }

  async searchVector(
    queryVector: number[],
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    // Empty store (no embedder + no prior index) — no semantic results.
    if (!this.table) return [];

    await this.ensureVectorIndex();

    const limit = options.limit ?? 20;
    let query = this.table.vectorSearch(queryVector).limit(limit);

    const filter = buildFilter(options);
    if (filter) {
      query = query.where(filter);
    }

    const results = await query.toArray();
    return results.map((row) => ({
      chunk: rowToChunk(row as ChunkRow),
      matchType: "semantic" as const,
    }));
  }

  async searchText(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.table) return [];

    await this.ensureFtsIndex();

    const limit = options.limit ?? 20;

    const ftsColumn = this.searchContentAvailable ? "searchContent" : "content";
    let search = this.table.search(query, "fts", ftsColumn).limit(limit);

    const filter = buildFilter(options);
    if (filter) {
      search = search.where(filter);
    }

    const results = await search.toArray();
    return results.map((row) => ({
      chunk: rowToChunk(row as ChunkRow),
      matchType: "lexical" as const,
    }));
  }

  async searchHybrid(
    queryVector: number[],
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.table) return [];

    await Promise.all([this.ensureVectorIndex(), this.ensureFtsIndex()]);

    // FTS index may not exist (e.g. table was never FTS-indexed) — fall through
    if (!this.ftsIndexExists) {
      return this.searchVector(queryVector, options);
    }

    const limit = options.limit ?? 20;
    const ftsColumn = this.searchContentAvailable ? "searchContent" : "content";
    const rrfK = options.rrfK ?? DEFAULT_RRF_K;
    const lancedb = await loadLanceDB();
    const rrf = await lancedb.rerankers.RRFReranker.create(rrfK);

    let q = this.table
      .query()
      .nearestTo(queryVector)
      .fullTextSearch(query, { columns: [ftsColumn] })
      .rerank(rrf)
      .limit(limit);

    const filter = buildFilter(options);
    if (filter) q = q.where(filter);

    const results = await q.toArray();
    // LanceDB returns results sorted by _relevance_score desc from RRFReranker.
    return results.map((row) => ({
      chunk: rowToChunk(row as ChunkRow),
      matchType: "hybrid" as const,
    }));
  }

  async listFiles(): Promise<string[]> {
    if (!this.table) return [];
    const results = await this.table.query().select(["filePath"]).toArray();
    const paths = new Set<string>();
    for (const row of results) {
      paths.add(row.filePath as string);
    }
    return [...paths].sort();
  }

  async getChunksByFile(filePath: string): Promise<CodeChunk[]> {
    if (!this.table) return [];
    const results = await this.table
      .query()
      .where(`filePath = ${sqlStr(filePath)}`)
      .toArray();
    return results.map((row) => rowToChunk(row as ChunkRow));
  }

  async getChunksByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!this.table || ids.length === 0) return [];
    const idList = ids.map(sqlStr).join(", ");
    const results = await this.table
      .query()
      .where(`id IN (${idList})`)
      .toArray();
    return results.map((row) => rowToChunk(row as ChunkRow));
  }

  async getAllSymbols(): Promise<
    Array<{
      filePath: string;
      type: string;
      name: string;
      startLine: number;
      endLine: number;
    }>
  > {
    if (!this.table) return [];
    const interestingTypes = [
      "function",
      "class",
      "method",
      "interface",
      "type",
      "enum",
      "arrow_function",
    ];
    const typeFilter = interestingTypes.map((t) => sqlStr(t)).join(", ");
    const results = await this.table
      .query()
      .where(`type IN (${typeFilter})`)
      .select(["filePath", "type", "name", "startLine", "endLine"])
      .toArray();
    return results.map((r) => ({
      filePath: r.filePath as string,
      type: r.type as string,
      name: r.name as string,
      startLine: r.startLine as number,
      endLine: r.endLine as number,
    }));
  }

  async countByLanguage(): Promise<Partial<Record<Language, number>>> {
    if (!this.table) return {};
    const results = await this.table.query().select(["language"]).toArray();
    const counts: Partial<Record<Language, number>> = {};
    for (const row of results) {
      const lang = row.language as Language;
      counts[lang] = (counts[lang] ?? 0) + 1;
    }
    return counts;
  }

  async countByType(): Promise<Partial<Record<ChunkType, number>>> {
    if (!this.table) return {};
    const results = await this.table.query().select(["type"]).toArray();
    const counts: Partial<Record<ChunkType, number>> = {};
    for (const row of results) {
      const type = row.type as ChunkType;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  async count(): Promise<number> {
    if (!this.table) return 0;
    return this.table.countRows();
  }

  async close(): Promise<void> {
    // LanceDB connections don't have an explicit close in the JS SDK
    this.table = null;
    this.db = null;
  }

  /**
   * Compact data files and refresh indexes. Call after batch indexing to
   * move the cost of incremental index maintenance out of the search path.
   * Advisory: failures are swallowed since stale indexes remain queryable.
   */
  async optimize(_opts?: { vacuum?: boolean }): Promise<void> {
    // `vacuum` is accepted for interface parity with SqliteVectorStore;
    // LanceDB has no equivalent heavy-rewrite mode — its standard optimize()
    // already compacts fragments, so the flag is a no-op here.
    if (!this.table) return;
    const count = await this.table.countRows();
    if (count === 0) return;

    const lancedb = await loadLanceDB();

    // Bootstrap FTS index on first run so optimize() has something to compact.
    if (!this.ftsIndexExists) {
      const column = this.searchContentAvailable ? "searchContent" : "content";
      try {
        await this.table.createIndex(column, { config: lancedb.Index.fts() });
      } catch {
        // May already exist from a prior session — flag and continue.
      }
      this.ftsIndexExists = true;
    }

    // Bootstrap IVF_PQ vector index once there are enough rows for it to pay off.
    if (count >= 65_536 && !this.vectorIndexed) {
      try {
        const numPartitions = Math.max(1, Math.floor(count / 256));
        await this.table.createIndex("vector", {
          config: lancedb.Index.ivfPq({ numPartitions }),
        });
      } catch {
        // Already exists or insufficient data — ignored.
      }
      this.vectorIndexed = true;
    }

    try {
      await this.table.optimize();
      this.ftsIndexed = true;
    } catch {
      // Non-fatal — optimize is advisory.
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async readMeta(): Promise<{
    modelId?: string;
    dimensions: number;
  } | null> {
    try {
      const data = await readFile(this.metaFilePath, "utf8");
      return JSON.parse(data) as { modelId?: string; dimensions: number };
    } catch {
      return null;
    }
  }

  private async writeMeta(): Promise<void> {
    if (this.dimensions === undefined) return; // nothing to persist yet
    try {
      await writeFile(
        this.metaFilePath,
        JSON.stringify({ modelId: this.modelId, dimensions: this.dimensions }),
      );
    } catch {
      // Non-fatal — metadata is advisory only
    }
  }

  /** Returns the vector dimension stored in the first row, or null if empty. */
  private async getStoredDimensions(): Promise<number | null> {
    if (!this.table) return null;
    try {
      const rows = await this.table.query().limit(1).toArray();
      if (rows.length === 0) return null;
      const vec = rows[0]?.vector;
      if (Array.isArray(vec)) return vec.length;
      // TypedArray (Float32Array etc.)
      if (vec && typeof (vec as { length?: number }).length === "number") {
        return (vec as { length: number }).length;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private async ensureFtsIndex(): Promise<void> {
    if (this.ftsIndexed || !this.table) return;
    const count = await this.table.countRows();
    if (count === 0) {
      this.ftsIndexed = true;
      return;
    }
    const column = this.searchContentAvailable ? "searchContent" : "content";
    const lancedb = await loadLanceDB();
    if (this.ftsIndexExists) {
      // Incremental update: merge new row fragments into the existing index.
      // optimize() is much faster than a full createIndex() rebuild.
      try {
        await this.table.optimize();
      } catch {
        // If optimize fails (e.g. index was dropped externally), fall back to full rebuild.
        try {
          await this.table.createIndex(column, { config: lancedb.Index.fts() });
        } catch {
          // Index may already be up-to-date — ignore.
        }
      }
    } else {
      // First time: build the FTS index from scratch.
      try {
        await this.table.createIndex(column, { config: lancedb.Index.fts() });
        this.ftsIndexExists = true;
      } catch {
        // Index may already exist from a prior session not reflected in the flag.
        this.ftsIndexExists = true;
      }
    }
    this.ftsIndexed = true;
  }

  private async ensureVectorIndex(): Promise<void> {
    if (this.vectorIndexed || !this.table) return;
    const count = await this.table.countRows();
    // IVF_PQ requires ~256 rows per partition and well-formed PQ codebooks.
    // LanceDB itself recommends ≥65,536 rows; below that a flat scan is fast
    // enough and avoids noisy KMeans empty-cluster warnings.
    if (count >= 65_536) {
      const numPartitions = Math.max(1, Math.floor(count / 256));
      const lancedb = await loadLanceDB();
      try {
        await this.table.createIndex("vector", {
          config: lancedb.Index.ivfPq({ numPartitions }),
        });
      } catch {
        // Already exists or not enough data
      }
    }
    this.vectorIndexed = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToChunk(row: ChunkRow): CodeChunk {
  return {
    id: row.id,
    projectId: row.projectId,
    filePath: row.filePath,
    language: row.language as Language,
    type: row.type as ChunkType,
    ...(row.name ? { name: row.name } : {}),
    content: row.content,
    contextContent: row.contextContent,
    startLine: row.startLine,
    endLine: row.endLine,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

/** Safely escapes a string value for interpolation into a LanceDB SQL filter. */
function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildFilter(options: SearchOptions): string | null {
  const conditions: string[] = [];

  if (options.language) {
    const langs = Array.isArray(options.language)
      ? options.language
      : [options.language];
    const langList = langs.map(sqlStr).join(", ");
    conditions.push(`language IN (${langList})`);
  }

  if (options.types && options.types.length > 0) {
    const typeList = options.types.map(sqlStr).join(", ");
    conditions.push(`type IN (${typeList})`);
  }

  if (options.filePath) {
    // Simple prefix/contains match (not full glob)
    const escaped = options.filePath.replace(/'/g, "''").replace(/\*/g, "%");
    if (escaped.includes("%")) {
      conditions.push(`filePath LIKE '${escaped}'`);
    } else {
      conditions.push(`filePath = '${escaped}'`);
    }
  }

  return conditions.length > 0 ? conditions.join(" AND ") : null;
}
