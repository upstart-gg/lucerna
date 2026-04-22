import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk } from "../../types.js";
import { getAbsorb } from "./absorbPresets.js";
import {
  absorbUpward,
  capitalize,
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

// tree-sitter-perl exposes statement nodes but doesn't surface their identifier
// children with stable field names; we capture the full statement and regex the
// name from its text. function_call doesn't exist in this grammar — the Perl
// runtime's call sites are matched via `expression_statement` text scans below.
const PERL_QUERIES = {
  uses: `(use_statement) @imp`,
  subs: `(subroutine_declaration_statement) @fn`,
  packages: `(package_statement) @pkg`,
};

export function extractPerl(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "perl";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(PERL_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return processWithPack(
      source,
      filePath,
      projectId,
      language,
      minMergeChars,
    );
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;
  const getMatches = (key: string): PatternMatch[] =>
    results[key]?.matches ?? [];
  const cap = (match: PatternMatch, name: string): MatchCapture | undefined =>
    match.captures.find((c) => c.name === name);

  const chunks: CodeChunk[] = [];
  const rawEdges: RawEdge[] = [];

  // --- Import chunk (use statements) ---
  let importContent = "";
  const useMatches = getMatches("uses");
  if (useMatches.length > 0) {
    const nodes = useMatches
      .map((m) => cap(m, "imp")?.node)
      .filter((n): n is NonNullable<typeof n> => n != null);
    const startLine = Math.min(...nodes.map((n) => n.startRow)) + 1;
    const endLine = Math.max(...nodes.map((n) => n.endRow)) + 1;
    importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "import",
      content: importContent,
      contextContent: importContent,
      startLine,
      endLine,
      metadata: {},
    });
    for (const m of useMatches) {
      const text = cap(m, "imp")?.text ?? "";
      const mod = text.match(/^use\s+([A-Za-z_][\w:]*)/)?.[1] ?? "";
      if (mod)
        rawEdges.push({
          sourceChunkId: "",
          sourceFilePath: filePath,
          type: "IMPORTS",
          targetSymbol: mod,
          targetFilePath: mod,
          metadata: {},
        });
    }
  }

  const absorb = getAbsorb(language);

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: ChunkType,
    parentName?: string,
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumbParts: string[] = [];
    if (parentName) breadcrumbParts.push(`# Package: ${parentName}`);
    breadcrumbParts.push(`# ${capitalize(type)}: ${name}`);
    const breadcrumb = breadcrumbParts.join("\n");
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type,
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: startRow + 1,
      endLine: node.endRow + 1,
      metadata: parentName
        ? { className: parentName, breadcrumb }
        : { breadcrumb },
    });
  };

  for (const m of getMatches("subs")) {
    const fnNode = cap(m, "fn")?.node;
    if (!fnNode) continue;
    const text = cap(m, "fn")?.text ?? "";
    const name = text.match(/^sub\s+([A-Za-z_][\w]*)/)?.[1] ?? "";
    if (!name) continue;
    addChunk(fnNode, name, "function");
  }

  // --- Moose / Moo `has` attribute declarations → property.
  // Match by scanning each non-function source line for `has NAME => (` or
  // `has 'NAME' => (`. The grammar doesn't expose a generic call_expression
  // node, so we walk the source directly.
  for (let row = 0; row < sourceLines.length; row++) {
    const line = sourceLines[row] ?? "";
    const m = line.match(/^\s*has\s+(?:['"])?([A-Za-z_][\w]*)/);
    if (!m) continue;
    const propName = m[1] ?? "";
    if (!propName) continue;
    const insideFn = chunks.some(
      (c) =>
        c.type === "function" && c.startLine <= row + 1 && c.endLine >= row + 1,
    );
    if (insideFn) continue;
    addChunk(
      { startRow: row, endRow: row } as NonNullable<MatchCapture["node"]>,
      propName,
      "property",
    );
  }

  if (chunks.length === 0) {
    return processWithPack(
      source,
      filePath,
      projectId,
      language,
      minMergeChars,
    );
  }

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges };
}
