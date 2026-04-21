import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { packExtract, type PatternMatch } from "./shared.js";

const XML_QUERIES = {
  // Top-level elements directly under the document root
  topElements: `(document (element (start_tag (tag_name) @name)) @elem)`,
};

export function extractXml(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "xml";

  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(XML_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    // XML parse failed — return a single whole-file chunk
    return {
      chunks: [
        {
          id: "",
          projectId,
          filePath,
          language,
          type: "file",
          content: source,
          contextContent: source,
          startLine: 1,
          endLine: sourceLines.length,
          metadata: {},
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
    // Split into one chunk per top-level element
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
      const breadcrumb = `<!-- Element: ${tagName} -->`;
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

  // Small file or ≤3 elements — return as a single chunk
  return {
    chunks: [
      {
        id: "",
        projectId,
        filePath,
        language,
        type: "file",
        content: source,
        contextContent: source,
        startLine: 1,
        endLine: sourceLines.length,
        metadata: {},
      },
    ],
    rawEdges,
  };
}
