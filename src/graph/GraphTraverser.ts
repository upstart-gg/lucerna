import type { GraphStoreInterface } from "../store/GraphStoreInterface.js";
import type { VectorStore } from "../store/VectorStore.js";
import type {
  CodeChunk,
  GraphEdge,
  GraphNeighborhood,
  GraphTraversalOptions,
} from "../types.js";

/**
 * Traverses the knowledge graph using BFS up to a configurable depth.
 *
 * Entry point: `getNeighborhood(chunkId)` — returns the center chunk plus
 * all reachable neighbours within `depth` hops, with their connecting edges.
 */
export class GraphTraverser {
  private readonly graphStore: GraphStoreInterface;
  private readonly vectorStore: VectorStore;

  constructor(graphStore: GraphStoreInterface, vectorStore: VectorStore) {
    this.graphStore = graphStore;
    this.vectorStore = vectorStore;
  }

  async getNeighborhood(
    chunkId: string,
    options: GraphTraversalOptions = {},
  ): Promise<GraphNeighborhood> {
    const depth = options.depth ?? 1;
    const limit = options.limit ?? 20;
    const relationTypes = options.relationTypes;

    // Fetch center chunk
    const centers = await this.vectorStore.getChunksByIds([chunkId]);
    const center = centers[0];
    if (!center) {
      return { center: emptyChunk(chunkId), edges: [] };
    }

    // BFS
    const visited = new Set<string>([chunkId]);
    const resultEdges: Array<{
      edge: GraphEdge;
      chunk: CodeChunk;
      direction: "outgoing" | "incoming";
    }> = [];
    let frontier = [chunkId];

    for (
      let hop = 0;
      hop < depth && frontier.length > 0 && resultEdges.length < limit;
      hop++
    ) {
      const nextFrontier: string[] = [];

      // Fetch all edges for the current frontier in parallel
      const edgeBatches = await Promise.all(
        frontier.map(async (id) => {
          const [outgoing, incoming] = await Promise.all([
            this.graphStore.getOutgoing(id, relationTypes),
            this.graphStore.getIncoming(id, relationTypes),
          ]);
          return { id, outgoing, incoming };
        }),
      );

      // Collect new neighbour IDs
      const newNeighbourIds: string[] = [];
      for (const { outgoing, incoming } of edgeBatches) {
        for (const edge of outgoing) {
          if (!visited.has(edge.targetChunkId)) {
            visited.add(edge.targetChunkId);
            newNeighbourIds.push(edge.targetChunkId);
            nextFrontier.push(edge.targetChunkId);
          }
        }
        for (const edge of incoming) {
          if (!visited.has(edge.sourceChunkId)) {
            visited.add(edge.sourceChunkId);
            newNeighbourIds.push(edge.sourceChunkId);
            nextFrontier.push(edge.sourceChunkId);
          }
        }
      }

      if (newNeighbourIds.length === 0) break;

      // Bulk-fetch neighbour chunks
      const neighbourChunks =
        await this.vectorStore.getChunksByIds(newNeighbourIds);
      const chunkMap = new Map<string, CodeChunk>(
        neighbourChunks.map((c) => [c.id, c]),
      );

      for (const { outgoing, incoming } of edgeBatches) {
        for (const edge of outgoing) {
          const chunk = chunkMap.get(edge.targetChunkId);
          if (chunk && resultEdges.length < limit) {
            resultEdges.push({ edge, chunk, direction: "outgoing" });
          }
        }
        for (const edge of incoming) {
          const chunk = chunkMap.get(edge.sourceChunkId);
          if (chunk && resultEdges.length < limit) {
            resultEdges.push({ edge, chunk, direction: "incoming" });
          }
        }
      }

      frontier = nextFrontier;
    }

    return { center, edges: resultEdges };
  }

  async getCallers(chunkId: string): Promise<CodeChunk[]> {
    const edges = await this.graphStore.getIncoming(chunkId, ["CALLS"]);
    if (edges.length === 0) return [];
    const ids = edges.map((e) => e.sourceChunkId);
    return this.vectorStore.getChunksByIds(ids);
  }

  async getCallees(chunkId: string): Promise<CodeChunk[]> {
    const edges = await this.graphStore.getOutgoing(chunkId, ["CALLS"]);
    if (edges.length === 0) return [];
    const ids = edges.map((e) => e.targetChunkId);
    return this.vectorStore.getChunksByIds(ids);
  }

  async getImplementors(chunkId: string): Promise<CodeChunk[]> {
    const edges = await this.graphStore.getIncoming(chunkId, [
      "IMPLEMENTS",
      "EXTENDS",
    ]);
    if (edges.length === 0) return [];
    const ids = [...new Set(edges.map((e) => e.sourceChunkId))];
    return this.vectorStore.getChunksByIds(ids);
  }

  async getSuperTypes(chunkId: string): Promise<CodeChunk[]> {
    const edges = await this.graphStore.getOutgoing(chunkId, [
      "EXTENDS",
      "IMPLEMENTS",
    ]);
    if (edges.length === 0) return [];
    const ids = [...new Set(edges.map((e) => e.targetChunkId))];
    return this.vectorStore.getChunksByIds(ids);
  }

  async getUsages(chunkId: string): Promise<CodeChunk[]> {
    const edges = await this.graphStore.getIncoming(chunkId, ["USES"]);
    if (edges.length === 0) return [];
    const ids = [...new Set(edges.map((e) => e.sourceChunkId))];
    return this.vectorStore.getChunksByIds(ids);
  }

  async getDependencies(
    filePath: string,
    vectorStore: VectorStore,
  ): Promise<CodeChunk[]> {
    // Find the import chunk for this file
    const fileChunks = await vectorStore.getChunksByFile(filePath);
    const importChunk = fileChunks.find((c) => c.type === "import");
    if (!importChunk) return [];

    const edges = await this.graphStore.getOutgoing(importChunk.id, [
      "IMPORTS",
    ]);
    if (edges.length === 0) return [];
    const ids = edges.map((e) => e.targetChunkId);
    return this.vectorStore.getChunksByIds(ids);
  }

  async getDependents(
    filePath: string,
    vectorStore: VectorStore,
  ): Promise<CodeChunk[]> {
    // Find the import chunk for this file (it is the target of incoming IMPORTS edges)
    const fileChunks = await vectorStore.getChunksByFile(filePath);
    const importChunk = fileChunks.find((c) => c.type === "import");
    if (!importChunk) return [];

    const edges = await this.graphStore.getIncoming(importChunk.id, [
      "IMPORTS",
    ]);
    if (edges.length === 0) return [];
    const ids = [...new Set(edges.map((e) => e.sourceChunkId))];
    return this.vectorStore.getChunksByIds(ids);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyChunk(id: string): CodeChunk {
  return {
    id,
    projectId: "",
    filePath: "",
    language: "typescript",
    type: "file",
    content: "",
    contextContent: "",
    startLine: 0,
    endLine: 0,
    metadata: {},
  };
}
