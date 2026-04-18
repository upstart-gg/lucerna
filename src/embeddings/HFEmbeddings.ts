import type {
  FeatureExtractionPipeline,
  Tensor,
} from "@huggingface/transformers";
import type { EmbeddingFunction } from "../types.js";

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

/**
 * Default embedding function using @huggingface/transformers.
 *
 * Uses the `Xenova/all-MiniLM-L6-v2` model by default, which produces
 * 384-dimensional sentence embeddings and runs entirely locally via ONNX.
 *
 * The pipeline is created lazily on first use to avoid blocking startup.
 */
export class HFEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly dtype: Dtype;
  private readonly maxBatchSize: number;
  private pipeline: FeatureExtractionPipeline | null = null;

  constructor(
    modelId = "Xenova/all-MiniLM-L6-v2",
    dimensions = 384,
    dtype: Dtype = "fp32",
    maxBatchSize = 32,
  ) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    this.dtype = dtype;
    this.maxBatchSize = maxBatchSize;
  }

  async generate(texts: string[]): Promise<number[][]> {
    const pipeline = await this.loadPipeline();

    // Process in batches to avoid OOM on large inputs
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);

      const output = (await pipeline(batch, {
        pooling: "mean",
        normalize: true,
      })) as Tensor;
      // Tensor.tolist() returns any[] — cast to the expected shape
      const vectors = output.tolist() as number[][];
      results.push(...vectors);
    }

    return results;
  }

  private async loadPipeline() {
    if (this.pipeline !== null) {
      return this.pipeline;
    }
    try {
      // Dynamic import to keep it optional at compile time
      const { pipeline, env } = await import("@huggingface/transformers");

      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      this.pipeline = await pipeline("feature-extraction", this.modelId, {
        dtype: this.dtype,
      });
    } catch (err) {
      throw new Error(
        `Failed to load embedding model "${this.modelId}". ` +
          `Ensure @huggingface/transformers is installed and the model is accessible.\n` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.pipeline;
  }

  /** Pre-load the model so the first generate() call has no cold-start delay. */
  async warmup(): Promise<void> {
    if (!this.pipeline) {
      await this.loadPipeline();
    }
  }

  /** Release the model pipeline and free memory. */
  async dispose(): Promise<void> {
    if (this.pipeline) {
      await this.pipeline.dispose();
      this.pipeline = null;
    }
  }
}
