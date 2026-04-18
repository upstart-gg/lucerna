import { HFEmbeddings } from "./HFEmbeddings.js";

/**
 * Code-aware embedding using `jinaai/jina-embeddings-v2-base-code`.
 *
 * Produces 768-dimensional embeddings with an 8K token context window and
 * is specifically trained on 30+ programming languages. Significantly
 * outperforms general-purpose models like `bge-small-en-v1.5` on code
 * retrieval tasks.
 *
 * This is the default local embedding model used by `CodeIndexer` when no
 * Cloudflare credentials are configured.
 *
 * Tradeoffs vs. `BGESmallEmbeddings` (bge-small-en-v1.5):
 *   - Better: code-aware vocabulary; 8K context (vs 512-token); 30+ languages
 *   - Larger: ~161M params vs ~33M; slower on CPU; 768-dim vectors (vs 384)
 *   - Incompatible: switching models requires clearing and re-indexing (different dims)
 *
 * @example
 * ```ts
 * import { CodeIndexer, JinaCodeEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new JinaCodeEmbeddings(),
 * });
 * ```
 */
export class JinaCodeEmbeddings extends HFEmbeddings {
  constructor() {
    super("jinaai/jina-embeddings-v2-base-code", 768);
  }
}
