import { HFEmbeddings } from "./HFEmbeddings.js";

/**
 * Pre-configured embedding function using `Xenova/bge-small-en-v1.5`.
 *
 * A high-quality ONNX model (33M params, MIT) that produces 384-dimensional
 * embeddings. Achieves a significantly better MTEB score (62.17) than the default
 * `all-MiniLM-L6-v2` (56.26) at the cost of ~2× slower indexing and ~28% higher
 * search latency.
 *
 * Tradeoffs vs. the default model:
 *   - Better: retrieval quality (+5.9 MTEB points)
 *   - Similar: speed (~1.5× larger model, same dims)
 *   - Same storage: both produce 384-dimensional vectors
 *
 * @example
 * ```ts
 * import { CodeIndexer, BGESmallEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new BGESmallEmbeddings(),
 * });
 * ```
 */
export class BGESmallEmbeddings extends HFEmbeddings {
  constructor() {
    super("Xenova/bge-small-en-v1.5", 384);
  }
}
