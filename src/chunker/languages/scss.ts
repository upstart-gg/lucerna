import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";

const SCSS_QUERIES = {
  rules: `(rule_set (selectors) @sel) @rule`,
  mixins: `(mixin_statement name: (identifier) @name) @mixin`,
  functions: `(function_statement name: (identifier) @name) @fn`,
};

export function extractScss(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "scss";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(SCSS_QUERIES).map(([k, q]) => [
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
  const mixinMatches = results.mixins?.matches ?? [];
  const fnMatches = results.functions?.matches ?? [];

  // Collect named chunks: mixins and functions first (always chunked if present)
  const namedChunks: CodeChunk[] = [];
  for (const m of [...mixinMatches, ...fnMatches]) {
    const anchor = m.captures.find(
      (c) => c.name === "mixin" || c.name === "fn",
    );
    const nameCapture = m.captures.find((c) => c.name === "name");
    if (!anchor?.node) continue;
    const node = anchor.node;
    const name = nameCapture?.text ?? "mixin";
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `/* Mixin/Function: ${name} */`;
    namedChunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "file",
      name,
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  }

  // Add rule chunks if there are enough rules to warrant splitting
  const ruleChunks: CodeChunk[] = [];
  if (ruleMatches.length > 3) {
    for (const m of ruleMatches) {
      const ruleCapture = m.captures.find((c) => c.name === "rule");
      const selCapture = m.captures.find((c) => c.name === "sel");
      if (!ruleCapture?.node) continue;
      const node = ruleCapture.node;
      const selector = selCapture?.text?.trim() ?? "rule";
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      const breadcrumb = `/* Selector: ${selector} */`;
      ruleChunks.push({
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
  }

  const allChunks = [...namedChunks, ...ruleChunks];
  if (allChunks.length > 0) return { chunks: allChunks, rawEdges };

  return {
    chunks: [makeFileChunk(source, filePath, projectId, language)],
    rawEdges,
  };
}
