import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";

const CSS_QUERIES = {
  rules: `(rule_set (selectors) @sel) @rule`,
};

export function extractCss(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "css";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(CSS_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, language)],
      rawEdges,
    };
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;
  const ruleMatches = results.rules?.matches ?? [];

  if (ruleMatches.length > 3) {
    const chunks: CodeChunk[] = [];
    for (const m of ruleMatches) {
      const ruleCapture = m.captures.find((c) => c.name === "rule");
      const selCapture = m.captures.find((c) => c.name === "sel");
      if (!ruleCapture?.node) continue;
      const node = ruleCapture.node;
      const selector = selCapture?.text?.trim() ?? "rule";
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      const breadcrumb = `/* File: ${filePath} */\n/* Selector: ${selector} */`;
      chunks.push({
        id: "",
        projectId,
        filePath,
        language,
        type: "file",
        name: selector,
        content,
        contextContent: `${breadcrumb}\n\n${content}`,
        startLine: node.startRow + 1,
        endLine: node.endRow + 1,
        metadata: { breadcrumb },
      });
    }
    if (chunks.length > 0) return { chunks, rawEdges };
  }

  return {
    chunks: [makeFileChunk(source, filePath, projectId, language)],
    rawEdges,
  };
}
