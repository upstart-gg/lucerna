import type { RerankingFunction } from "../types.js";
import { type VertexAuthOptions, getVertexAccessToken } from "./vertexAuth.js";

const BATCH_SIZE = 200;

export class VertexAIReranker implements RerankingFunction {
  private readonly model: string;
  private readonly project: string;
  private readonly authOptions: VertexAuthOptions;

  constructor(
    options: {
      model?: string;
      project?: string;
      keyFile?: string;
    } = {},
  ) {
    this.model = options.model ?? "semantic-ranker-default-004";

    const project = options.project;
    if (!project) {
      throw new Error(
        "VertexAIReranker: project is required. Set it in your lucerna.config.ts.",
      );
    }
    this.project = project;
    this.authOptions =
      options.keyFile !== undefined ? { keyFile: options.keyFile } : {};
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    const scores = new Array<number>(texts.length).fill(0);
    const accessToken = await getVertexAccessToken(this.authOptions);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const records = batch.map((content, j) => ({
        id: String(i + j),
        content,
      }));

      const url =
        `https://discoveryengine.googleapis.com/v1/projects/${this.project}` +
        `/locations/global/rankingConfigs/default_ranking_config:rank`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ model: this.model, query, records }),
      });

      if (!res.ok) {
        throw new Error(
          `VertexAIReranker: API error ${res.status}: ${await res.text()}`,
        );
      }

      const json = (await res.json()) as {
        records: { id: string; score: number }[];
      };

      for (const record of json.records) {
        const idx = parseInt(record.id, 10);
        if (!Number.isNaN(idx)) scores[idx] = record.score;
      }
    }

    return scores;
  }
}
