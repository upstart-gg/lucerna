import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk, packExtract, type PatternMatch } from "./shared.js";
import { extractTsJs } from "./typescript.js";

const SVELTE_QUERIES = {
  scripts: `(script_element) @block`,
  styles: `(style_element) @block`,
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

  const namedBlocks: CodeChunk[] = [];
  const coveredRows = new Set<number>();

  // Styles → single "section" chunk
  for (const m of results.styles?.matches ?? []) {
    const capture = m.captures.find((c) => c.name === "block");
    if (!capture?.node) continue;
    const node = capture.node;
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `// Section: style`;
    namedBlocks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "section",
      name: "style",
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
    for (let r = node.startRow; r <= node.endRow; r++) coveredRows.add(r);
  }

  // Scripts → re-run TS/JS extraction so each function/class becomes its own chunk
  for (const m of results.scripts?.matches ?? []) {
    const capture = m.captures.find((c) => c.name === "block");
    if (!capture?.node) continue;
    const node = capture.node;
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
        namedBlocks.push(c);
      }
      rawEdges.push(...scriptEdges);
    } else {
      // Fall back to a single "section" chunk
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      const breadcrumb = `// Section: script`;
      namedBlocks.push({
        id: "",
        projectId,
        filePath,
        language,
        type: "section",
        name: "script",
        content,
        contextContent: `${breadcrumb}\n\n${content}`,
        startLine: node.startRow + 1,
        endLine: node.endRow + 1,
        metadata: { breadcrumb },
      });
    }
    for (let r = node.startRow; r <= node.endRow; r++) coveredRows.add(r);
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
    const breadcrumb = `// Section: template`;
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
