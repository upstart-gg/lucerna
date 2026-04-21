import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";

const VUE_QUERIES = {
  blocks: `[(script_element) (template_element) (style_element)] @block`,
};

export function extractVue(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "vue";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(VUE_QUERIES).map(([k, q]) => [
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
  const blockMatches = results.blocks?.matches ?? [];

  if (blockMatches.length === 0) {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, language)],
      rawEdges,
    };
  }

  const chunks: CodeChunk[] = [];
  for (const m of blockMatches) {
    const capture = m.captures.find((c) => c.name === "block");
    if (!capture?.node) continue;
    const node = capture.node;
    // Derive block name from node kind: "script_element" → "script"
    const blockName =
      (node as unknown as { kind?: string }).kind?.replace("_element", "") ??
      "block";
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `// Section: ${blockName}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "section",
      name: blockName,
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  }

  if (chunks.length > 0) return { chunks, rawEdges };
  return {
    chunks: [makeFileChunk(source, filePath, projectId, language)],
    rawEdges,
  };
}
