import type { EmbeddingFunction } from "../types.js";
import { charBudgetBatches, prepareTexts, reassembleVectors } from "./utils.js";
import { type VertexAuthOptions, getVertexAccessToken } from "./vertexAuth.js";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-005": 768,
  "text-embedding-004": 768,
  "text-multilingual-embedding-002": 768,
};

// VertexAI limits: 2,048 tokens per text, 20,000 tokens total per batch, 250 texts max.
// We budget chars = tokens (1:1) — the worst case for dense code with single-char tokens.
// This guarantees we never exceed the token limits regardless of content.
const MAX_PER_TEXT_CHARS = 2_000; // hard ceiling: ≤ 2,000 tokens at worst case
const MAX_BATCH_CHARS = 18_000; // hard ceiling: ≤ 18,000 tokens at worst case (10% under 20k limit)
const MAX_BATCH_ITEMS = 250;

export class VertexAIEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;

  private readonly project: string;
  private readonly location: string;
  private readonly authOptions: VertexAuthOptions;

  constructor(options: {
    model: string;
    project?: string;
    location?: string;
    keyFile?: string;
    dimensions?: number;
  }) {
    this.modelId = options.model;

    const project = options.project;
    if (!project) {
      throw new Error(
        "VertexAIEmbeddings: project is required. Set it in your lucerna.config.ts.",
      );
    }
    this.project = project;
    this.location = options.location ?? "us-central1";
    this.authOptions =
      options.keyFile !== undefined ? { keyFile: options.keyFile } : {};

    const knownDim = MODEL_DIMENSIONS[options.model];
    if (options.dimensions !== undefined) {
      this.dimensions = options.dimensions;
    } else if (knownDim !== undefined) {
      this.dimensions = knownDim;
    } else {
      throw new Error(
        `VertexAIEmbeddings: unknown model "${options.model}". Pass options.dimensions explicitly or use "vertex:${options.model}:<dims>" format.`,
      );
    }
  }

  async generate(texts: string[]): Promise<number[][]> {
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.modelId}:predict`;
    const accessToken = await getVertexAccessToken(this.authOptions);

    const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
    const pieceVectors: number[][] = [];

    for (const batch of charBudgetBatches(
      pieces,
      MAX_BATCH_CHARS,
      MAX_BATCH_ITEMS,
    )) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          instances: batch.map((content) => ({
            content,
            task_type: "RETRIEVAL_DOCUMENT",
          })),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(
          `VertexAIEmbeddings: API error ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as {
        predictions: { embeddings: { values: number[] } }[];
      };
      for (const prediction of json.predictions) {
        pieceVectors.push(prediction.embeddings.values);
      }
    }

    return reassembleVectors(pieceVectors, ranges);
  }
}
