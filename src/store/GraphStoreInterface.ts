import type { GraphEdge, RelationshipType } from "../types.js";

/**
 * Shared interface implemented by both the LanceDB-backed `GraphStore` and the
 * SQLite-backed `SqliteGraphStore`. Lets the `CodeIndexer` and graph traverser
 * stay backend-agnostic.
 */
export interface GraphStoreInterface {
  initialize(): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  deleteEdgesByFile(filePath: string): Promise<void>;
  deleteEdgesByTargetChunks(chunkIds: string[]): Promise<void>;
  getOutgoing(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]>;
  getIncoming(
    chunkId: string,
    types?: RelationshipType[],
  ): Promise<GraphEdge[]>;
  countEdges(): Promise<number>;
  countByType(): Promise<Partial<Record<RelationshipType, number>>>;
  close(): Promise<void>;
}
