import { HFEmbeddings } from "./HFEmbeddings.js";

/**
 * High-quality embedding using `onnx-community/embeddinggemma-300m-ONNX`.
 *
 * This is the **default local embedding model** used by `CodeIndexer` when no
 * Cloudflare credentials are configured.
 *
 * Produces 768-dimensional embeddings. Achieves MTEB English 68.4 and MTEB
 * Code 68.8 — significantly outperforming code-specific alternatives at this
 * size class. Uses the q4f16 quantized ONNX variant (~175 MB).
 *
 * **License notice**: the underlying model weights are subject to the
 * [Google Gemma Terms of Use](https://ai.google.dev/gemma/terms). Weights are
 * downloaded from HuggingFace Hub at runtime and are never bundled with
 * Lucerna. By using this embedding provider you agree to those terms.
 *
 * Tradeoffs vs. `JinaCodeEmbeddings`:
 *   - Better: MTEB Code 68.8 vs CoIR 58.4; higher general retrieval quality
 *   - Worse: 2K context window (vs 8K); Gemma license (vs Apache 2.0)
 *   - Similar size: ~175 MB vs ~162 MB
 *
 * Tradeoffs vs. `NomicTextEmbeddings`:
 *   - Better: MTEB 68.4 vs 62.3; better code retrieval
 *   - Worse: 2K context window (vs 8K); Gemma license (vs Apache 2.0)
 *   - Slightly larger: ~175 MB vs ~137 MB
 *
 * @example
 * ```ts
 * import { CodeIndexer, GemmaEmbeddings } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   embeddingFunction: new GemmaEmbeddings(),
 * });
 * ```
 */
export class GemmaEmbeddings extends HFEmbeddings {
  constructor() {
    // q4f16 uses model_q4f16.onnx (~175 MB). Uses last_token pooling
    // because embeddinggemma is a decoder-style embedding model.
    super(
      "onnx-community/embeddinggemma-300m-ONNX",
      768,
      "q4f16",
      32,
      "last_token",
    );
  }
}
