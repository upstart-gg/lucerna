import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";
import { extractTsJs } from "./typescript.js";

const VUE_QUERIES = {
  blocks: `[(script_element) (template_element) (style_element)] @block`,
};

function extractScriptBlockAsTs(
  sourceLines: string[],
  blockStartRow: number,
  blockEndRow: number,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  let contentStart = blockStartRow + 1;
  for (let i = blockStartRow; i <= blockEndRow; i++) {
    if (/<script[^>]*>/.test(sourceLines[i] ?? "")) {
      contentStart = i + 1;
      break;
    }
  }
  let contentEnd = blockEndRow - 1;
  for (let i = blockEndRow; i >= blockStartRow; i--) {
    if (/<\/script>/.test(sourceLines[i] ?? "")) {
      contentEnd = i - 1;
      break;
    }
  }
  if (contentEnd < contentStart) return { chunks: [], rawEdges: [] };
  const inner = sourceLines.slice(contentStart, contentEnd + 1).join("\n");
  const { chunks, rawEdges } = extractTsJs(
    inner,
    filePath,
    projectId,
    "typescript",
    0,
  );
  for (const c of chunks) {
    c.startLine += contentStart;
    c.endLine += contentStart;
  }
  return { chunks, rawEdges };
}

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
    const blockKind =
      (node as unknown as { kind?: string }).kind?.replace("_element", "") ??
      "block";

    if (blockKind === "script") {
      const { chunks: scriptChunks, rawEdges: scriptEdges } =
        extractScriptBlockAsTs(
          sourceLines,
          node.startRow,
          node.endRow,
          filePath,
          projectId,
        );
      if (scriptChunks.length > 0) {
        for (const c of scriptChunks) {
          c.language = language;
          chunks.push(c);
        }
        rawEdges.push(...scriptEdges);
        continue;
      }
      // Fall through to emit as a section if TS extraction produced nothing
    }

    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `// Section: ${blockKind}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "section",
      name: blockKind,
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
