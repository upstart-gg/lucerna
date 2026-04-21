import { hashEdgeId } from "../graph/types.js";
import type { GraphEdge, RelationshipType } from "../types.js";
import type { GraphStoreInterface } from "./GraphStoreInterface.js";
import type { SqliteVectorStore } from "./SqliteVectorStore.js";

// biome-ignore lint/suspicious/noExplicitAny: shared sqlite handle type
type Database = any;
// biome-ignore lint/suspicious/noExplicitAny: sqlite statement type
type Statement = any;

interface EdgeRow {
  id: string;
  projectId: string;
  sourceChunkId: string;
  sourceFilePath: string;
  targetChunkId: string;
  type: string;
  metadata: string;
}

/**
 * GraphStore counterpart for the SQLite backend. Reuses the connection owned
 * by `SqliteVectorStore` — both tables live in the same `.db` file.
 */
export class SqliteGraphStore implements GraphStoreInterface {
  private readonly vectorStore: SqliteVectorStore;
  private db: Database | null = null;
  private stmts: {
    insertEdge: Statement;
    deleteEdgeById: Statement;
    deleteByFile: Statement;
    getOutgoing: Statement;
    getIncoming: Statement;
    countEdges: Statement;
    countByType: Statement;
  } | null = null;

  constructor(vectorStore: SqliteVectorStore) {
    this.vectorStore = vectorStore;
  }

  async initialize(): Promise<void> {
    this.db = this.vectorStore.getDb();
    this.stmts = {
      insertEdge: this.db.prepare(
        `INSERT INTO edges (id, projectId, sourceChunkId, sourceFilePath, targetChunkId, type, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteEdgeById: this.db.prepare("DELETE FROM edges WHERE id = ?"),
      deleteByFile: this.db.prepare(
        "DELETE FROM edges WHERE sourceFilePath = ?",
      ),
      getOutgoing: this.db.prepare(
        "SELECT * FROM edges WHERE sourceChunkId = ?",
      ),
      getIncoming: this.db.prepare(
        "SELECT * FROM edges WHERE targetChunkId = ?",
      ),
      countEdges: this.db.prepare("SELECT COUNT(*) AS c FROM edges"),
      countByType: this.db.prepare(
        "SELECT type, COUNT(*) AS c FROM edges GROUP BY type",
      ),
    };
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (!this.db || !this.stmts || edges.length === 0) return;
    const stmts = this.stmts;
    const run = this.db.transaction((items: GraphEdge[]) => {
      for (const e of items) {
        stmts.deleteEdgeById.run(e.id);
        stmts.insertEdge.run(
          e.id,
          e.projectId,
          e.sourceChunkId,
          e.sourceFilePath,
          e.targetChunkId,
          e.type,
          JSON.stringify(e.metadata),
        );
      }
    });
    run(edges);
  }

  async deleteEdgesByFile(filePath: string): Promise<void> {
    if (!this.stmts) return;
    this.stmts.deleteByFile.run(filePath);
  }

  async deleteEdgesByTargetChunks(chunkIds: string[]): Promise<void> {
    if (!this.db || chunkIds.length === 0) return;
    const BATCH = 500;
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const batch = chunkIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM edges WHERE targetChunkId IN (${placeholders})`)
        .run(...batch);
    }
  }

  async getOutgoing(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    if (!this.db || !this.stmts) return [];
    let rows: EdgeRow[];
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(", ");
      rows = this.db
        .prepare(
          `SELECT * FROM edges WHERE sourceChunkId = ? AND type IN (${placeholders})`,
        )
        .all(chunkId, ...types) as EdgeRow[];
    } else {
      rows = this.stmts.getOutgoing.all(chunkId) as EdgeRow[];
    }
    return rows.map(rowToEdge);
  }

  async getIncoming(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]> {
    if (!this.db || !this.stmts) return [];
    let rows: EdgeRow[];
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(", ");
      rows = this.db
        .prepare(
          `SELECT * FROM edges WHERE targetChunkId = ? AND type IN (${placeholders})`,
        )
        .all(chunkId, ...types) as EdgeRow[];
    } else {
      rows = this.stmts.getIncoming.all(chunkId) as EdgeRow[];
    }
    return rows.map(rowToEdge);
  }

  async countEdges(): Promise<number> {
    if (!this.stmts) return 0;
    const row = this.stmts.countEdges.get() as { c: number };
    return row.c;
  }

  async countByType(): Promise<Partial<Record<RelationshipType, number>>> {
    if (!this.stmts) return {};
    const rows = this.stmts.countByType.all() as Array<{
      type: string;
      c: number;
    }>;
    const out: Partial<Record<RelationshipType, number>> = {};
    for (const r of rows) out[r.type as RelationshipType] = r.c;
    return out;
  }

  async close(): Promise<void> {
    // Connection is owned by SqliteVectorStore — nothing to close here.
    this.db = null;
    this.stmts = null;
  }
}

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

export { hashEdgeId };
