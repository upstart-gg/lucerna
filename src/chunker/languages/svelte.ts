import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";

const SVELTE_QUERIES = {
  scripts: `(script_element) @block`,
  styles: `(style_element) @block`,
};

export function extractSvelte(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "svelte";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(SVELTE_QUERIES).map(([k, q]) => [
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

  // Collect script and style blocks, tracking which rows are covered
  const namedBlocks: CodeChunk[] = [];
  const coveredRows = new Set<number>();

  for (const key of ["scripts", "styles"]) {
    for (const m of results[key]?.matches ?? []) {
      const capture = m.captures.find((c) => c.name === "block");
      if (!capture?.node) continue;
      const node = capture.node;
      const blockName =
        (node as unknown as { kind?: string }).kind?.replace("_element", "") ??
        key;
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      const breadcrumb = `// File: ${filePath}\n// Section: ${blockName}`;
      namedBlocks.push({
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
      for (let r = node.startRow; r <= node.endRow; r++) coveredRows.add(r);
    }
  }

  // Remaining lines form the template chunk
  const templateLines: string[] = [];
  let templateStart = -1;
  let templateEnd = -1;
  for (let i = 0; i < sourceLines.length; i++) {
    if (!coveredRows.has(i)) {
      if (templateStart === -1) templateStart = i;
      templateEnd = i;
      templateLines.push(sourceLines[i] ?? "");
    }
  }

  const chunks: CodeChunk[] = [...namedBlocks];

  if (templateLines.length > 0 && templateLines.join("").trim()) {
    const content = templateLines.join("\n");
    const breadcrumb = `// File: ${filePath}\n// Section: template`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "section",
      name: "template",
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: templateStart + 1,
      endLine: templateEnd + 1,
      metadata: { breadcrumb },
    });
  }

  if (chunks.length > 0) return { chunks, rawEdges };
  return {
    chunks: [makeFileChunk(source, filePath, projectId, language)],
    rawEdges,
  };
}
