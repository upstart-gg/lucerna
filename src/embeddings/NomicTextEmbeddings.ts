import { HFEmbeddings } from "./HFEmbeddings.js";

/**
 * General-purpose embedding using `nomic-ai/nomic-embed-text-v1.5`.
 *
 * Produces 768-dimensional embeddings with an 8K token context window.
 * Strong MTEB score (62.3 average) with Apache 2.0 license. Uses the
 * q8 quantized ONNX variant (137 MB).
 *
 * Tradeoffs vs. `JinaCodeEmbeddings`:
 *   - Better: 8K context, Apache 2.0 license, slightly higher general MTEB
 *   - Worse: not code-specialized (no code-vocabulary fine-tuning)
 *   - Same: 768-dim vectors, similar on-disk size (~137 MB vs ~162 MB)
 *
 * Tradeoffs vs. `GemmaEmbeddings` (default):
 *   - Better: 8K context window (vs 2K), fully Apache 2.0 license
 *   - Worse: lower MTEB score (62.3 vs 68.4 general / 68.8 code)
 *   - Smaller: 137 MB vs 175 MB
 *
 * @example
 * ```ts
 * import { CodeIndexer, NomicTextEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new NomicTextEmbeddings(),
 * });
 * ```
 */
export class NomicTextEmbeddings extends HFEmbeddings {
  constructor() {
    // q8 uses model_quantized.onnx (137 MB)
    super("nomic-ai/nomic-embed-text-v1.5", 768, "q8");
  }
}
