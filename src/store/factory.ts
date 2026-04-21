import type { GraphStoreInterface } from "./GraphStoreInterface.js";
import type { VectorStore } from "./VectorStore.js";

export type VectorStoreBackend = "lancedb" | "sqlite";

export interface CreateStoreBundleOptions {
  backend: VectorStoreBackend;
  storageDir: string;
  dimensions: number;
  modelId?: string | undefined;
}

export interface StoreBundle {
  vectorStore: VectorStore;
  graphStore: GraphStoreInterface;
}

/**
 * Build and initialize a vector store + graph store pair for the selected
 * backend. The concrete modules are loaded via dynamic `import()` so that
 * missing optional dependencies only surface when the user actually chooses
 * that backend.
 */
export async function createStoreBundle(
  opts: CreateStoreBundleOptions,
): Promise<StoreBundle> {
  if (opts.backend === "sqlite") {
    const { SqliteVectorStore } = await import("./SqliteVectorStore.js");
    const { SqliteGraphStore } = await import("./SqliteGraphStore.js");
    const vectorStore = new SqliteVectorStore({
      storageDir: opts.storageDir,
      dimensions: opts.dimensions,
      modelId: opts.modelId,
    });
    await vectorStore.initialize();
    const graphStore = new SqliteGraphStore(vectorStore);
    await graphStore.initialize();
    return { vectorStore, graphStore };
  }

  const { LanceDBStore } = await import("./LanceDBStore.js");
  const { GraphStore } = await import("./GraphStore.js");
  const vectorStore = new LanceDBStore({
    storageDir: opts.storageDir,
    dimensions: opts.dimensions,
    modelId: opts.modelId,
  });
  await vectorStore.initialize();
  const graphStore = new GraphStore(opts.storageDir);
  await graphStore.initialize();
  return { vectorStore, graphStore };
}
