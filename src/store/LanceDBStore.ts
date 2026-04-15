import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
import type {
  ChunkType,
  CodeChunk,
  Language,
  SearchOptions,
  SearchResult,
} from "../types.js";
import type { VectorStore } from "./VectorStore.js";

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

// ---------------------------------------------------------------------------
// LanceDBStore
// ---------------------------------------------------------------------------

export interface LanceDBStoreOptions {
  /** Directory where the LanceDB files are stored */
  storageDir: string;
  /** Dimensionality of the embedding vectors */
  dimensions: number;
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
  private readonly dimensions: number;
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
    this.db = await lancedb.connect(this.storageDir);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes("chunks")) {
      this.table = await this.db.openTable("chunks");
      // Guard against silent vector space corruption when the embedding model
      // changes. If the stored vector dimension differs from the configured one,
      // search results would be garbage and upserts would fail at the LanceDB
      // level with an unhelpful schema error.
      const storedDim = await this.getStoredDimensions();
      if (storedDim !== null && storedDim !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: the index was built with ${storedDim}-dimensional vectors ` +
            `but the current model produces ${this.dimensions}-dimensional vectors. ` +
            `Run 'lucerna clear' then 'lucerna index' to rebuild the index with the new model.`,
        );
      }
      // Warn if the model identifier changed (soft check — dimensions may still match
      // if two models happen to share the same output size, but embeddings are incompatible)
      const meta = await this.readMeta();
      if (meta?.modelId && this.modelId && meta.modelId !== this.modelId) {
        console.warn(
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
        console.warn(
          "[lucerna] Index was built without code-aware BM25 tokenization. " +
            "Run `lucerna clear` then `lucerna index` to enable identifier expansion.",
        );
      }
    } else {
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
  }

  async upsert(chunks: CodeChunk[], vectors: number[][]): Promise<void> {
    if (!this.table) throw new Error("LanceDBStore not initialized");
    if (chunks.length === 0) return;

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
      vector: vectors[i] ?? new Array(this.dimensions).fill(0),
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
    if (!this.table) throw new Error("LanceDBStore not initialized");

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
      score: 1 - ((row._distance as number) ?? 0), // convert L2 distance → similarity
      matchType: "semantic" as const,
    }));
  }

  async searchText(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.table) throw new Error("LanceDBStore not initialized");

    await this.ensureFtsIndex();

    const limit = options.limit ?? 20;

    const ftsColumn = this.searchContentAvailable ? "searchContent" : "content";
    let search = this.table.search(query, "fts", ftsColumn).limit(limit);

    const filter = buildFilter(options);
    if (filter) {
      search = search.where(filter);
    }

    const results = await search.toArray();
    return results.map((row, idx) => ({
      chunk: rowToChunk(row as ChunkRow),
      // BM25 scores are not normalised; use rank-based score
      score: 1 / (1 + idx),
      matchType: "lexical" as const,
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
    // IVF_PQ is only beneficial at scale; use flat index for small tables.
    // LanceDB warns about empty clusters when count < ~65k, so we gate at 10k
    // to avoid noisy warnings on small/benchmark datasets.
    if (count >= 10_000) {
      try {
        await this.table.createIndex("vector", {
          config: lancedb.Index.ivfPq({ numPartitions: 32 }),
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

/**
 * Expands camelCase, PascalCase, and snake_case identifiers so BM25 can match
 * sub-words. The original token is preserved so exact-match queries still work.
 *
 * Examples:
 *   getUserById  → "getUserById get user by id"
 *   parse_json   → "parse_json parse json"
 *   HTTPSClient  → "HTTPSClient https client"
 */
function expandIdentifiers(text: string): string {
  return text.replace(/[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]/g, (token) => {
    const parts = token
      .split("_")
      .flatMap((part) =>
        part
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .split(" "),
      )
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    const unique = [...new Set(parts)];
    if (unique.length <= 1) return token;
    return `${token} ${unique.join(" ")}`;
  });
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
