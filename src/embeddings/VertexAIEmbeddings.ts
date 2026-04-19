import type { EmbeddingFunction } from "../types.js";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-005": 768,
  "text-embedding-004": 768,
  "text-multilingual-embedding-002": 768,
};

export class VertexAIEmbeddings implements EmbeddingFunction {
  readonly dimensions: number;
  readonly modelId: string;

  private readonly project: string;
  private readonly location: string;
  private readonly accessToken: string;

  constructor(options: {
    model: string;
    project?: string;
    location?: string;
    accessToken?: string;
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

    const accessToken = options.accessToken;
    if (!accessToken) {
      throw new Error(
        "VertexAIEmbeddings: accessToken is required. Set it in your lucerna.config.ts " +
          "(obtain via: gcloud auth print-access-token).",
      );
    }
    this.accessToken = accessToken;

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
    const BATCH = 250;
    const results: number[][] = [];
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.modelId}:predict`;

    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          instances: batch.map((content) => ({
            content,
            task_type: "RETRIEVAL_DOCUMENT",
          })),
        }),
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
        results.push(prediction.embeddings.values);
      }
    }
    return results;
  }
}
