import type { RerankingFunction } from "../types.js";

type Dtype =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "q4f16"
  | "bnb4";

// Minimal callable interfaces for the lower-level transformers.js APIs.
// AutoTokenizer / AutoModelForSequenceClassification instances are callable
// via JS Proxy at runtime; TypeScript doesn't expose call signatures on them.
type RerankerTokenizer = (
  queries: string[],
  opts: {
    text_pair: string[];
    padding: boolean;
    truncation: boolean;
    max_length: number;
  },
) => Record<string, unknown>;

type RerankerModel = ((inputs: Record<string, unknown>) => Promise<{
  logits: { data: Float32Array };
}>) & { dispose?(): Promise<void> };

/**
 * Local reranking function using @huggingface/transformers.
 *
 * Uses `AutoModelForSequenceClassification` + `AutoTokenizer` to score
 * (query, document) pairs via a cross-encoder model running locally via ONNX.
 * No API key required.
 *
 * The model is loaded lazily on first use to avoid blocking startup.
 */
export class HFReranker implements RerankingFunction {
  readonly modelId: string;
  private readonly dtype: Dtype;
  private readonly maxLength: number;
  private readonly maxBatchSize: number;
  private tokenizer: RerankerTokenizer | null = null;
  private model: RerankerModel | null = null;

  constructor(
    modelId: string,
    dtype: Dtype = "fp32",
    maxLength = 512,
    maxBatchSize = 16,
  ) {
    this.modelId = modelId;
    this.dtype = dtype;
    this.maxLength = maxLength;
    this.maxBatchSize = maxBatchSize;
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];

    await this.loadModel();
    const tokenizer = this.tokenizer as RerankerTokenizer;
    const model = this.model as RerankerModel;
    const scores: number[] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const queries = batch.map(() => query);

      const inputs = tokenizer(queries, {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: this.maxLength,
      });

      const output = await model(inputs);
      for (const logit of output.logits.data) {
        scores.push(1 / (1 + Math.exp(-logit)));
      }
    }

    return scores;
  }

  private async loadModel(): Promise<void> {
    if (this.tokenizer !== null && this.model !== null) return;
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import("@huggingface/transformers");

      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      this.tokenizer = (await AutoTokenizer.from_pretrained(
        this.modelId,
      )) as unknown as RerankerTokenizer;

      this.model = (await AutoModelForSequenceClassification.from_pretrained(
        this.modelId,
        { dtype: this.dtype },
      )) as unknown as RerankerModel;
    } catch (err) {
      throw new Error(
        `Failed to load reranker model "${this.modelId}". ` +
          `Ensure @huggingface/transformers is installed and the model is accessible.\n` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Pre-load the model so the first rerank() call has no cold-start delay. */
  async warmup(): Promise<void> {
    await this.loadModel();
  }

  /** Release the model and tokenizer and free memory. */
  async dispose(): Promise<void> {
    if (this.model) {
      await this.model.dispose?.();
      this.model = null;
    }
    this.tokenizer = null;
  }
}
