import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { packExtract, type PatternMatch } from "./shared.js";

const HTML_QUERIES = {
  // Top-level elements directly under the document root
  topElements: `(document (element (start_tag (tag_name) @name)) @elem)`,
};

export function extractHtml(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "html";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(HTML_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return {
      chunks: [
        {
          id: "",
          projectId,
          filePath,
          language,
          type: "file",
          content: source,
          contextContent: `<!-- File: ${filePath} -->\n\n${source}`,
          startLine: 1,
          endLine: sourceLines.length,
          metadata: { breadcrumb: `<!-- File: ${filePath} -->` },
        },
      ],
      rawEdges,
    };
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;
  const elemMatches = results.topElements?.matches ?? [];

  if (elemMatches.length > 3) {
    const chunks: CodeChunk[] = [];
    for (const m of elemMatches) {
      const elemCapture = m.captures.find((c) => c.name === "elem");
      const nameCapture = m.captures.find((c) => c.name === "name");
      if (!elemCapture?.node) continue;
      const node = elemCapture.node;
      const tagName = nameCapture?.text ?? "element";
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      const breadcrumb = `<!-- File: ${filePath} -->\n<!-- Element: ${tagName} -->`;
      chunks.push({
        id: "",
        projectId,
        filePath,
        language,
        type: "file",
        name: tagName,
        content,
        contextContent: `${breadcrumb}\n\n${content}`,
        startLine: node.startRow + 1,
        endLine: node.endRow + 1,
        metadata: { breadcrumb },
      });
    }
    if (chunks.length > 0) return { chunks, rawEdges };
  }

  const breadcrumb = `<!-- File: ${filePath} -->`;
  return {
    chunks: [
      {
        id: "",
        projectId,
        filePath,
        language,
        type: "file",
        content: source,
        contextContent: `${breadcrumb}\n\n${source}`,
        startLine: 1,
        endLine: sourceLines.length,
        metadata: { breadcrumb },
      },
    ],
    rawEdges,
  };
}
