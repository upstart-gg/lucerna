import { HFReranker } from "./HFReranker.js";

/**
 * Local reranking using `jinaai/jina-reranker-v1-turbo-en`.
 *
 * Runs entirely locally via ONNX — no API key required. Uses the q8
 * quantized variant (~38 MB). Achieves BEIR NDCG@10 of 49.60 with an 8K
 * token context window (code chunks fit without truncation).
 *
 * Tradeoffs vs. API-based rerankers:
 *   - No cost, no network round-trip, no rate limits
 *   - ~38 MB download on first use (cached locally by HuggingFace)
 *   - Slightly lower quality than larger cloud models
 *   - 8K context — same as JinaReranker (API), more than CloudflareReranker (512)
 *
 * @example
 * ```ts
 * import { CodeIndexer, LocalReranker } from 'lucerna';
 *
 * const indexer = new CodeIndexer({
 *   projectRoot: '.',
 *   rerankingFunction: new LocalReranker(),
 * });
 * ```
 */
export class LocalReranker extends HFReranker {
  constructor() {
    // q8 uses model_quantized.onnx (~38 MB), 8K token context window
    super("jinaai/jina-reranker-v1-turbo-en", "q8", 8192);
  }
}
