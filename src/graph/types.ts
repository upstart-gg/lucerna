import { createHash } from "node:crypto";
import type { CodeChunk, RelationshipType } from "../types.js";

// ---------------------------------------------------------------------------
// Internal types used by the edge extraction + resolution pipeline.
// These are NOT part of the public API.
// ---------------------------------------------------------------------------

/**
 * An edge spec emitted by a language extractor before chunk IDs are assigned.
 * `sourceStartLine` identifies the source chunk by its start line; it is
 * converted to a `sourceChunkId` once IDs are stable.
 */
export interface EdgeSpec {
  /** Start line of the source chunk (used to look up its ID after assignment) */
  sourceStartLine: number;
  type: RelationshipType;
  /**
   * For DEFINES edges: the target chunk's already-resolved ID.
   * For all other types: the symbol name or import specifier to be resolved.
   */
  targetSymbol: string;
  /** Import specifier path (e.g. "./utils" or "@/auth") — set on IMPORTS edges */
  targetFilePath?: string;
  metadata: Record<string, unknown>;
}

/**
 * An unresolved edge with a known sourceChunkId but an unresolved target.
 * Produced by TreeSitterChunker.chunkSourceWithEdges() and consumed by SymbolResolver.
 */
export interface RawEdge {
  sourceChunkId: string;
  sourceFilePath: string;
  type: RelationshipType;
  /** Symbol name / import specifier, or (for DEFINES) the already-resolved targetChunkId */
  targetSymbol: string;
  /** Import path hint for IMPORTS and symbol edges where the import origin is known */
  targetFilePath?: string;
  metadata: Record<string, unknown>;
}

/**
 * Result returned by chunkSourceWithEdges / chunkFileWithEdges.
 */
export interface ChunkingWithEdgesResult {
  chunks: CodeChunk[];
  rawEdges: RawEdge[];
}

// ---------------------------------------------------------------------------
// Shared utility — single canonical implementation used by GraphStore and
// SymbolResolver to avoid duplicating the hashing logic.
// ---------------------------------------------------------------------------

export function hashEdgeId(
  projectId: string,
  sourceChunkId: string,
  targetChunkId: string,
  type: string,
): string {
  return createHash("sha1")
    .update(`${projectId}:${sourceChunkId}:${targetChunkId}:${type}`)
    .digest("hex")
    .slice(0, 16);
}
