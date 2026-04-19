import type { RerankingFunction } from "../types.js";

export class GeminiReranker implements RerankingFunction {
  private readonly model: string;
  private readonly apiKey: string;

  constructor(options: { model?: string; apiKey?: string } = {}) {
    this.model = options.model ?? "gemini-2.0-flash-lite";

    const apiKey = options.apiKey;
    if (!apiKey) {
      throw new Error(
        "GeminiReranker: apiKey is required. Set it in your lucerna.config.ts.",
      );
    }
    this.apiKey = apiKey;
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    const passageList = texts
      .map((t, i) => `${i}: ${t.replace(/\n/g, " ")}`)
      .join("\n");

    const prompt =
      `You are a relevance scoring system. For the query below, score each passage 0–1 (1 = most relevant).\n\n` +
      `Query: ${query}\n\nPassages:\n${passageList}\n\n` +
      `Return ONLY a JSON array of numbers in the same order as the passages, e.g. [0.9, 0.3, 0.7].`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent` +
      `?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GeminiReranker: API error ${res.status}: ${await res.text()}`,
      );
    }

    const json = (await res.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };

    const raw = json.candidates[0]?.content.parts[0]?.text ?? "";

    let scores: unknown;
    try {
      scores = JSON.parse(raw);
    } catch {
      throw new Error(
        `GeminiReranker: failed to parse response as JSON. Raw: ${raw.slice(0, 200)}`,
      );
    }

    if (
      !Array.isArray(scores) ||
      scores.length !== texts.length ||
      !scores.every((s) => typeof s === "number")
    ) {
      throw new Error(
        `GeminiReranker: expected a number array of length ${texts.length}, got: ${raw.slice(0, 200)}`,
      );
    }

    return scores as number[];
  }
}
