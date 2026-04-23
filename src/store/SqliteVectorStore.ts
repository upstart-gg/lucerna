import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ChunkType,
  CodeChunk,
  Language,
  SearchOptions,
  SearchResult,
} from "../types.js";
import { expandIdentifiers } from "./identifierExpansion.js";
import type { VectorStore } from "./VectorStore.js";

// ---------------------------------------------------------------------------
// Dynamic loading of native deps (kept out of the lancedb install path)
// ---------------------------------------------------------------------------

// The SQLite driver can be either `better-sqlite3` (Node) or `bun:sqlite` (Bun).
// Both expose a near-identical subset of the API we use (prepare/run/all/get,
// exec, transaction, loadExtension) — we wrap the pragma difference below.
// biome-ignore lint/suspicious/noExplicitAny: sqlite driver types are loaded dynamically
type Database = any;
// biome-ignore lint/suspicious/noExplicitAny: sqlite statement type varies by driver
type Statement = any;

interface SqliteDeps {
  /** Opens a database at the given path (with WAL + FK pragmas applied). */
  open: (path: string) => Database;
  /** Loads the sqlite-vec extension into an open database. */
  load: (db: Database) => void;
}

/**
 * Loads the platform-specific path to the sqlite-vec extension binary.
 * `sqlite-vec`'s own `load()` helper is bypassed because some drivers (e.g.
 * `bun:sqlite`) accept only a plain path string and not a full call helper.
 */
async function getVecLoadablePath(): Promise<string> {
  try {
    const mod = (await import("sqlite-vec")) as unknown as {
      getLoadablePath: () => string;
    };
    return mod.getLoadablePath();
  } catch (err) {
    throw new Error(
      `The "sqlite-vec" package is required for the sqlite backend but could not be loaded. ` +
        `Install it with 'pnpm add sqlite-vec' (or run 'lucerna install' and pick sqlite). ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

let depsPromise: Promise<SqliteDeps> | null = null;
async function loadDeps(): Promise<SqliteDeps> {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    // biome-ignore lint/suspicious/noExplicitAny: runtime feature detection
    const isBun = typeof (globalThis as any).Bun !== "undefined";
    const vecPath = await getVecLoadablePath();

    if (isBun) {
      try {
        const mod = (await import("bun:sqlite")) as unknown as {
          Database: (new (
            path: string,
          ) => Database) & {
            setCustomSQLite: (path: string) => void;
          };
        };
        // macOS's system SQLite is compiled without dynamic extension loading,
        // which is required by sqlite-vec. When running on darwin under Bun,
        // point bun:sqlite at a user-supplied or homebrew-provided SQLite
        // library that does support it.
        if (process.platform === "darwin") {
          const candidates = [
            process.env.LUCERNA_SQLITE_LIB,
            "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
            "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
          ].filter((p): p is string => typeof p === "string" && p.length > 0);
          const { existsSync } = await import("node:fs");
          const libPath = candidates.find((p) => existsSync(p));
          if (libPath) {
            try {
              mod.Database.setCustomSQLite(libPath);
            } catch (err) {
              // `setCustomSQLite` can only be called once per process, before
              // any Database has been opened. When lucerna is embedded in a
              // host program that has already touched `bun:sqlite`, this call
              // throws. That's fine: either the host already pointed
              // `bun:sqlite` at an extension-capable SQLite (in which case
              // loadExtension below succeeds), or it didn't — in which case
              // loadExtension will throw a clearer error than we could here.
              if (!/already loaded/i.test((err as Error).message)) throw err;
            }
          }
        }
        return {
          open: (path: string) => {
            const db = new mod.Database(path);
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA foreign_keys = ON");
            return db;
          },
          load: (db: Database) => db.loadExtension(vecPath),
        };
      } catch (err) {
        throw new Error(
          `Failed to open the 'bun:sqlite' driver: ${(err as Error).message}`,
        );
      }
    }

    try {
      const mod = (await import("better-sqlite3")) as unknown as {
        default: new (path: string) => Database;
      };
      const BetterSqlite3 = mod.default;
      return {
        open: (path: string) => {
          const db = new BetterSqlite3(path);
          db.pragma("journal_mode = WAL");
          db.pragma("foreign_keys = ON");
          return db;
        },
        load: (db: Database) => db.loadExtension(vecPath),
      };
    } catch (err) {
      throw new Error(
        `The "better-sqlite3" package is required for the sqlite backend but could not be loaded. ` +
          `Install it with 'pnpm add better-sqlite3' (or run 'lucerna install' and pick sqlite). ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }
  })();
  return depsPromise;
}

// ---------------------------------------------------------------------------
// Options & schema
// ---------------------------------------------------------------------------

export interface SqliteVectorStoreOptions {
  /** Base directory under which `sqlite/lucerna.db` is created. */
  storageDir: string;
  /** Dimensionality of the embedding vectors. */
  dimensions: number;
  /** Optional model identifier — persisted to index-meta.json. */
  modelId?: string | undefined;
}

interface ChunkRow {
  rowid: number;
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
  metadata: string;
  searchContent: string;
}

// ---------------------------------------------------------------------------
// SqliteVectorStore
// ---------------------------------------------------------------------------

/**
 * VectorStore backed by SQLite (better-sqlite3) + sqlite-vec.
 *
 * Layout: `<storageDir>/sqlite/lucerna.db`. The same file also hosts the
 * `edges` table so `SqliteGraphStore` can reuse the connection.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly dbPath: string;
  private readonly metaFilePath: string;
  private readonly dimensions: number;
  private readonly modelId: string | undefined;
  private db: Database | null = null;
  private searchContentAvailable = true;
  private stmts: {
    insertChunk: Statement;
    deleteChunkById: Statement;
    deleteVecByRowid: Statement;
    insertVec: Statement;
    rowidById: Statement;
    getById: Statement;
    getByFile: Statement;
    listFiles: Statement;
    count: Statement;
    countByLanguage: Statement;
    countByType: Statement;
    getAllSymbols: Statement;
  } | null = null;

  constructor(options: SqliteVectorStoreOptions) {
    this.dbPath = join(options.storageDir, "sqlite", "lucerna.db");
    this.metaFilePath = join(options.storageDir, "index-meta.json");
    this.dimensions = options.dimensions;
    this.modelId = options.modelId;
  }

  /** Exposes the underlying connection so `SqliteGraphStore` can share it. */
  getDb(): Database {
    if (!this.db) throw new Error("SqliteVectorStore not initialized");
    return this.db;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const { open, load } = await loadDeps();
    const db = open(this.dbPath);
    load(db);

    // Existing index? Validate dimensions.
    const existingDim = getStoredDimensions(db);
    if (existingDim !== null && existingDim !== this.dimensions) {
      db.close();
      throw new Error(
        `Embedding dimension mismatch: the index was built with ${existingDim}-dimensional vectors ` +
          `but the current model produces ${this.dimensions}-dimensional vectors. ` +
          `Run 'lucerna clear' then 'lucerna index' to rebuild the index with the new model.`,
      );
    }

    this.createSchema(db);
    this.db = db;
    this.prepareStatements();

    // Model-change warning (same soft check as LanceDBStore)
    const meta = await this.readMeta();
    if (meta?.modelId && this.modelId && meta.modelId !== this.modelId) {
      console.warn(
        `[lucerna] Embedding model changed: index was built with "${meta.modelId}" ` +
          `but the current model is "${this.modelId}". ` +
          `Search quality may be degraded. Run 'lucerna clear' then 'lucerna index' to rebuild.`,
      );
    }
    if (existingDim === null) {
      // Fresh index — write meta
      await this.writeMeta();
    }
  }

  private createSchema(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id             TEXT PRIMARY KEY,
        projectId      TEXT NOT NULL,
        filePath       TEXT NOT NULL,
        language       TEXT NOT NULL,
        type           TEXT NOT NULL,
        name           TEXT NOT NULL DEFAULT '',
        content        TEXT NOT NULL,
        contextContent TEXT NOT NULL,
        startLine      INTEGER NOT NULL,
        endLine        INTEGER NOT NULL,
        metadata       TEXT NOT NULL DEFAULT '{}',
        searchContent  TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file     ON chunks(filePath);
      CREATE INDEX IF NOT EXISTS idx_chunks_language ON chunks(language);
      CREATE INDEX IF NOT EXISTS idx_chunks_type     ON chunks(type);

      CREATE TABLE IF NOT EXISTS edges (
        id             TEXT PRIMARY KEY,
        projectId      TEXT NOT NULL,
        sourceChunkId  TEXT NOT NULL,
        sourceFilePath TEXT NOT NULL,
        targetChunkId  TEXT NOT NULL,
        type           TEXT NOT NULL,
        metadata       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(sourceChunkId);
      CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(targetChunkId);
      CREATE INDEX IF NOT EXISTS idx_edges_srcFile ON edges(sourceFilePath);
    `);

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
         chunk_rowid INTEGER PRIMARY KEY,
         embedding FLOAT[${this.dimensions}]
       );`,
    );

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
         searchContent,
         content='chunks',
         content_rowid='rowid',
         tokenize='unicode61'
       );
       CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
         INSERT INTO chunks_fts(rowid, searchContent) VALUES (new.rowid, new.searchContent);
       END;
       CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
         INSERT INTO chunks_fts(chunks_fts, rowid, searchContent) VALUES ('delete', old.rowid, old.searchContent);
       END;
       CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
         INSERT INTO chunks_fts(chunks_fts, rowid, searchContent) VALUES ('delete', old.rowid, old.searchContent);
         INSERT INTO chunks_fts(rowid, searchContent) VALUES (new.rowid, new.searchContent);
       END;`,
    );
  }

  private prepareStatements(): void {
    const db = this.db;
    if (!db) throw new Error("SqliteVectorStore not initialized");
    this.stmts = {
      insertChunk: db.prepare(
        `INSERT INTO chunks (id, projectId, filePath, language, type, name, content, contextContent, startLine, endLine, metadata, searchContent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteChunkById: db.prepare("DELETE FROM chunks WHERE id = ?"),
      deleteVecByRowid: db.prepare(
        "DELETE FROM vec_chunks WHERE chunk_rowid = ?",
      ),
      insertVec: db.prepare(
        "INSERT INTO vec_chunks (chunk_rowid, embedding) VALUES (?, ?)",
      ),
      rowidById: db.prepare("SELECT rowid FROM chunks WHERE id = ?"),
      getById: db.prepare("SELECT * FROM chunks WHERE id = ?"),
      getByFile: db.prepare(
        "SELECT * FROM chunks WHERE filePath = ? ORDER BY startLine",
      ),
      listFiles: db.prepare(
        "SELECT DISTINCT filePath FROM chunks ORDER BY filePath",
      ),
      count: db.prepare("SELECT COUNT(*) AS c FROM chunks"),
      countByLanguage: db.prepare(
        "SELECT language, COUNT(*) AS c FROM chunks GROUP BY language",
      ),
      countByType: db.prepare(
        "SELECT type, COUNT(*) AS c FROM chunks GROUP BY type",
      ),
      getAllSymbols: db.prepare(
        `SELECT filePath, type, name, startLine, endLine FROM chunks
         WHERE type IN ('function','class','method','interface','type','enum','arrow_function')`,
      ),
    };
  }

  async upsert(chunks: CodeChunk[], vectors: number[][]): Promise<void> {
    if (!this.db || !this.stmts) {
      throw new Error("SqliteVectorStore not initialized");
    }
    if (chunks.length === 0) return;

    const stmts = this.stmts;
    const dims = this.dimensions;
    const doUpsert = this.db.transaction(
      (items: Array<{ chunk: CodeChunk; vector: number[] }>) => {
        for (const { chunk, vector } of items) {
          // Delete existing row (if any) — cascades to vec_chunks via app logic below.
          const existing = stmts.rowidById.get(chunk.id) as
            | { rowid: number }
            | undefined;
          if (existing) {
            // sqlite-vec's vec0 virtual table rejects any value not bound as
            // SQLITE_INTEGER — and better-sqlite3 binds plain JS numbers as
            // SQLITE_FLOAT. Pass a BigInt to force the integer affinity.
            stmts.deleteVecByRowid.run(BigInt(existing.rowid));
            stmts.deleteChunkById.run(chunk.id);
          }

          const info = stmts.insertChunk.run(
            chunk.id,
            chunk.projectId,
            chunk.filePath,
            chunk.language,
            chunk.type,
            chunk.name ?? "",
            chunk.content,
            chunk.contextContent,
            chunk.startLine,
            chunk.endLine,
            JSON.stringify(chunk.metadata),
            expandIdentifiers(
              chunk.name ? `${chunk.content} ${chunk.name}` : chunk.content,
            ),
          );

          const vec =
            Array.isArray(vector) && vector.length === dims
              ? vector
              : new Array(dims).fill(0);
          stmts.insertVec.run(BigInt(info.lastInsertRowid), toFloat32Blob(vec));
        }
      },
    );
    doUpsert(chunks.map((chunk, i) => ({ chunk, vector: vectors[i] ?? [] })));

    const meta = await this.readMeta();
    if (!meta) await this.writeMeta();
  }

  async delete(ids: string[]): Promise<void> {
    if (!this.db || !this.stmts || ids.length === 0) return;
    const stmts = this.stmts;
    const run = this.db.transaction((batch: string[]) => {
      for (const id of batch) {
        const row = stmts.rowidById.get(id) as { rowid: number } | undefined;
        if (row) {
          stmts.deleteVecByRowid.run(BigInt(row.rowid));
          stmts.deleteChunkById.run(id);
        }
      }
    });
    run(ids);
  }

  async deleteByFile(filePath: string): Promise<void> {
    if (!this.db) return;
    const rows = this.db
      .prepare("SELECT rowid FROM chunks WHERE filePath = ?")
      .all(filePath) as Array<{ rowid: number }>;
    if (rows.length === 0) return;
    const stmts = this.stmts;
    if (!stmts) return;
    const run = this.db.transaction((batch: Array<{ rowid: number }>) => {
      for (const r of batch) stmts.deleteVecByRowid.run(BigInt(r.rowid));
      this.db?.prepare("DELETE FROM chunks WHERE filePath = ?").run(filePath);
    });
    run(rows);
  }

  async searchVector(
    queryVector: number[],
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.db) throw new Error("SqliteVectorStore not initialized");
    const limit = options.limit ?? 20;
    const hasFilter =
      options.language !== undefined ||
      (options.types && options.types.length > 0) ||
      options.filePath !== undefined;
    // Post-filter: fetch more candidates if a filter is applied.
    const fetchLimit = hasFilter ? Math.max(limit * 4, 50) : limit;

    const neighbours = this.db
      .prepare(
        `SELECT chunk_rowid AS rowid, distance
         FROM vec_chunks WHERE embedding MATCH ?
         ORDER BY distance LIMIT ?`,
      )
      .all(toFloat32Blob(queryVector), fetchLimit) as Array<{
      rowid: number;
      distance: number;
    }>;
    if (neighbours.length === 0) return [];

    const rowids = neighbours.map((n) => n.rowid);
    const chunksByRowid = this.fetchChunksByRowid(rowids);

    const results: SearchResult[] = [];
    for (const n of neighbours) {
      const row = chunksByRowid.get(n.rowid);
      if (!row) continue;
      if (!matchesFilter(row, options)) continue;
      results.push({
        chunk: rowToChunk(row),
        score: 1 - n.distance,
        matchType: "semantic" as const,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  async searchText(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.db) throw new Error("SqliteVectorStore not initialized");
    const limit = options.limit ?? 20;
    const hasFilter =
      options.language !== undefined ||
      (options.types && options.types.length > 0) ||
      options.filePath !== undefined;
    const fetchLimit = hasFilter ? Math.max(limit * 4, 50) : limit;

    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    let rows: Array<{ rowid: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
        .all(ftsQuery, fetchLimit) as Array<{ rowid: number }>;
    } catch {
      // Malformed FTS5 query (e.g. user-input punctuation). Fall back to LIKE.
      const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const column = this.searchContentAvailable ? "searchContent" : "content";
      rows = this.db
        .prepare(
          `SELECT rowid FROM chunks WHERE ${column} LIKE ? ESCAPE '\\' LIMIT ?`,
        )
        .all(like, fetchLimit) as Array<{ rowid: number }>;
    }
    if (rows.length === 0) return [];

    const chunksByRowid = this.fetchChunksByRowid(rows.map((r) => r.rowid));
    const results: SearchResult[] = [];
    let idx = 0;
    for (const r of rows) {
      const row = chunksByRowid.get(r.rowid);
      if (!row) continue;
      if (!matchesFilter(row, options)) continue;
      results.push({
        chunk: rowToChunk(row),
        score: 1 / (1 + idx),
        matchType: "lexical" as const,
      });
      idx++;
      if (results.length >= limit) break;
    }
    return results;
  }

  async searchHybrid(
    queryVector: number[],
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 20;
    const innerOpts = { ...options, limit: limit * 3 };
    const k = options.rrfK ?? 45;
    const [semantic, lexical] = await Promise.all([
      this.searchVector(queryVector, innerOpts),
      this.searchText(query, innerOpts),
    ]);
    return fuseRrf(semantic, lexical, limit, k);
  }

  async listFiles(): Promise<string[]> {
    if (!this.db || !this.stmts) return [];
    const rows = this.stmts.listFiles.all() as Array<{ filePath: string }>;
    return rows.map((r) => r.filePath);
  }

  async getChunksByFile(filePath: string): Promise<CodeChunk[]> {
    if (!this.db || !this.stmts) return [];
    const rows = this.stmts.getByFile.all(filePath) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  async getChunksByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!this.db || ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  async count(): Promise<number> {
    if (!this.db || !this.stmts) return 0;
    const row = this.stmts.count.get() as { c: number };
    return row.c;
  }

  async countByLanguage(): Promise<Partial<Record<Language, number>>> {
    if (!this.db || !this.stmts) return {};
    const rows = this.stmts.countByLanguage.all() as Array<{
      language: string;
      c: number;
    }>;
    const out: Partial<Record<Language, number>> = {};
    for (const r of rows) out[r.language as Language] = r.c;
    return out;
  }

  async countByType(): Promise<Partial<Record<ChunkType, number>>> {
    if (!this.db || !this.stmts) return {};
    const rows = this.stmts.countByType.all() as Array<{
      type: string;
      c: number;
    }>;
    const out: Partial<Record<ChunkType, number>> = {};
    for (const r of rows) out[r.type as ChunkType] = r.c;
    return out;
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
    if (!this.db || !this.stmts) return [];
    return this.stmts.getAllSymbols.all() as Array<{
      filePath: string;
      type: string;
      name: string;
      startLine: number;
      endLine: number;
    }>;
  }

  async optimize(opts?: { vacuum?: boolean }): Promise<void> {
    if (!this.db) return;
    try {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
    } catch {
      // Advisory — safe to ignore.
    }
    // Fold the WAL back into the main DB and truncate it to 0 bytes.
    // Without this, the `.db` file is missing any writes still sitting in
    // the WAL — so committing the DB to git would produce an incomplete index.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Advisory.
    }
    if (opts?.vacuum) {
      try {
        this.db.exec("VACUUM");
      } catch {
        // VACUUM fails if any prepared statements hold open cursors.
        // Non-fatal — the DB is still usable.
      }
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      // Flush any pending WAL into the main DB and zero-truncate the WAL file
      // before closing. SQLite's implicit on-close checkpoint doesn't truncate,
      // so without this the WAL persists on disk across runs — which both
      // wastes space and makes the `.db` file an incomplete snapshot for
      // versioning.
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Advisory.
      }
      try {
        this.db.close();
      } catch {
        // Ignore double-close
      }
      this.db = null;
    }
    this.stmts = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private fetchChunksByRowid(rowids: number[]): Map<number, ChunkRow> {
    const map = new Map<number, ChunkRow>();
    if (!this.db || rowids.length === 0) return map;
    const placeholders = rowids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT rowid, * FROM chunks WHERE rowid IN (${placeholders})`)
      .all(...rowids) as ChunkRow[];
    for (const r of rows) map.set(r.rowid, r);
    return map;
  }

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
    try {
      await writeFile(
        this.metaFilePath,
        JSON.stringify({ modelId: this.modelId, dimensions: this.dimensions }),
      );
    } catch {
      // Non-fatal — metadata is advisory only
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-scope)
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

function toFloat32Blob(values: number[]): Buffer {
  const arr = Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function matchesFilter(row: ChunkRow, options: SearchOptions): boolean {
  if (options.language !== undefined) {
    const langs = Array.isArray(options.language)
      ? options.language
      : [options.language];
    if (!langs.includes(row.language)) return false;
  }
  if (options.types && options.types.length > 0) {
    if (!options.types.includes(row.type as ChunkType)) return false;
  }
  if (options.filePath !== undefined) {
    const raw = options.filePath;
    if (raw.includes("*")) {
      // Simple glob → regex. Matches LanceDB's LIKE translation.
      const escaped = raw
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      if (!new RegExp(`^${escaped}$`).test(row.filePath)) return false;
    } else if (row.filePath !== raw) {
      return false;
    }
  }
  return true;
}

function getStoredDimensions(db: Database): number | null {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'",
    )
    .get() as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const m = row.sql.match(/FLOAT\[(\d+)\]/i);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Sanitise an arbitrary user query for FTS5 MATCH by quoting each whitespace-
 * separated token. Characters unsafe in FTS5 syntax (`"`, `*`, `:`) are stripped
 * inside the token.
 */
function buildFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["*:]/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}

function fuseRrf(
  semantic: SearchResult[],
  lexical: SearchResult[],
  limit: number,
  k: number,
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();
  const add = (results: SearchResult[]) => {
    results.forEach((r, rank) => {
      const id = r.chunk.id;
      const rrf = 1 / (k + rank + 1);
      const existing = scoreMap.get(id);
      if (existing) existing.score += rrf;
      else scoreMap.set(id, { result: r, score: rrf });
    });
  };
  add(semantic);
  add(lexical);
  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({
      ...result,
      score,
      matchType: "hybrid" as const,
    }));
}
