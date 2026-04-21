import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import { hashEdgeId } from "../graph/types.js";
import type { GraphEdge, RelationshipType } from "../types.js";
import type { GraphStoreInterface } from "./GraphStoreInterface.js";

// Dynamic import keeps `@lancedb/lancedb` an optional dep.
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
// Schema
// ---------------------------------------------------------------------------

interface EdgeRow extends Record<string, unknown> {
  id: string;
  projectId: string;
  sourceChunkId: string;
  sourceFilePath: string;
  targetChunkId: string;
  type: string;
  metadata: string; // JSON
}

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

/**
 * Persists knowledge-graph edges in a LanceDB "edges" table stored alongside
 * the chunks table in the same `storageDir/lance/` directory.
 */
export class GraphStore implements GraphStoreInterface {
  private readonly storageDir: string;
  private db: Connection | null = null;
  private table: Table | null = null;

  constructor(storageDir: string) {
    // Share the same lance/ sub-directory used by LanceDBStore
    this.storageDir = join(storageDir, "lance");
  }

  async initialize(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.storageDir);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes("edges")) {
      this.table = await this.db.openTable("edges");
    } else {
      const emptyRow: EdgeRow = {
        id: "__init__",
        projectId: "",
        sourceChunkId: "",
        sourceFilePath: "",
        targetChunkId: "",
        type: "",
        metadata: "{}",
      };
      this.table = await this.db.createTable("edges", [emptyRow]);
      await this.table.delete('id = "__init__"');
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (!this.table || edges.length === 0) return;

    const ids = edges.map((e) => sqlStr(e.id)).join(", ");
    await this.table.delete(`id IN (${ids})`);

    const rows: EdgeRow[] = edges.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      sourceChunkId: e.sourceChunkId,
      sourceFilePath: e.sourceFilePath,
      targetChunkId: e.targetChunkId,
      type: e.type,
      metadata: JSON.stringify(e.metadata),
    }));

    await this.table.add(rows);
  }

  async deleteEdgesByFile(filePath: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`sourceFilePath = ${sqlStr(filePath)}`);
  }

  async deleteEdgesByTargetChunks(chunkIds: string[]): Promise<void> {
    if (!this.table || chunkIds.length === 0) return;
    const BATCH = 500;
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const batch = chunkIds.slice(i, i + BATCH);
      const idList = batch.map(sqlStr).join(", ");
      await this.table.delete(`targetChunkId IN (${idList})`);
    }
  }

  async getOutgoing(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    if (!this.table) return [];
    let filter = `sourceChunkId = ${sqlStr(chunkId)}`;
    if (types && types.length > 0) {
      const typeList = types.map(sqlStr).join(", ");
      filter += ` AND type IN (${typeList})`;
    }
    const results = await this.table.query().where(filter).toArray();
    return results.map((row) => rowToEdge(row as EdgeRow));
  }

  async getIncoming(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    if (!this.table) return [];
    let filter = `targetChunkId = ${sqlStr(chunkId)}`;
    if (types && types.length > 0) {
      const typeList = types.map(sqlStr).join(", ");
      filter += ` AND type IN (${typeList})`;
    }
    const results = await this.table.query().where(filter).toArray();
    return results.map((row) => rowToEdge(row as EdgeRow));
  }

  async countEdges(): Promise<number> {
    if (!this.table) return 0;
    return this.table.countRows();
  }

  async countByType(): Promise<Partial<Record<RelationshipType, number>>> {
    if (!this.table) return {};
    const results = await this.table.query().select(["type"]).toArray();
    const counts: Partial<Record<RelationshipType, number>> = {};
    for (const row of results) {
      const type = row.type as RelationshipType;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceChunkId: row.sourceChunkId,
    sourceFilePath: row.sourceFilePath,
    targetChunkId: row.targetChunkId,
    type: row.type as RelationshipType,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

/** Safely escapes a string value for interpolation into a LanceDB SQL filter. */
function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export { hashEdgeId };
