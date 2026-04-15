import { HFEmbeddings } from "./HFEmbeddings.js";

/**
 * Code-aware embedding using `nomic-ai/nomic-embed-code`.
 *
 * Produces 768-dimensional embeddings with an 8K token context window and
 * is specifically trained on code. Significantly outperforms general-purpose
 * models like `bge-small-en-v1.5` on the CoIR code retrieval benchmark.
 *
 * This is the default local embedding model used by `CodeIndexer` when no
 * Cloudflare credentials are configured.
 *
 * Tradeoffs vs. `BGESmallEmbeddings` (bge-small-en-v1.5):
 *   - Better: ~2× CoIR recall; code-aware vocabulary; 8K context (vs 512-token)
 *   - Larger: ~137M params vs ~33M; slower on CPU; 768-dim vectors (vs 384)
 *   - Incompatible: switching models requires clearing and re-indexing (different dims)
 *
 * @example
 * ```ts
 * import { CodeIndexer, NomicCodeEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new NomicCodeEmbeddings(),
 * });
 * ```
 */
export class NomicCodeEmbeddings extends HFEmbeddings {
  constructor() {
    super("nomic-ai/nomic-embed-code", 768);
  }
}
