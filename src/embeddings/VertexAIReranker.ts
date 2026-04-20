import type { RerankingFunction } from "../types.js";
import { truncateWithEllipsis } from "./utils.js";
import { type VertexAuthOptions, getVertexAccessToken } from "./vertexAuth.js";

const BATCH_SIZE = 200;

// semantic-ranker-default-004: 1,024 tokens per record (title + content combined).
// Using 2 chars/token → 2,048 chars. Truncate proactively to preserve head+tail signal
// rather than letting the server silently drop the tail.
const MAX_DOC_CHARS = 2_000;
// Query shares the 1,024-token budget with each document.
const MAX_QUERY_CHARS = 500;

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
    const safeQuery = truncateWithEllipsis(query, MAX_QUERY_CHARS);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const records = batch.map((content, j) => ({
        id: String(i + j),
        content: truncateWithEllipsis(content, MAX_DOC_CHARS),
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
        body: JSON.stringify({ model: this.model, query: safeQuery, records }),
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
