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

const R_QUERIES = {
  // library(...) and require(...) calls for imports
  imports: `(call function: (identifier) @func arguments: (arguments (string) @module)) @imp`,
  // Functions defined via <- assignment: name <- function(...)
  functions: `(binary_operator lhs: (identifier) @name operator: "<-" rhs: (function_definition)) @fn`,
  callExpressions: `(call function: (identifier) @callee) @call`,
};

// S4 class system: setClass, setMethod, setGeneric
const S4_CALL_NAMES = new Set(["setClass", "setMethod", "setGeneric"]);

export function extractR(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "r";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(R_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (library / require calls) ---
  let importContent = "";
  const importMatches = getMatches("imports").filter((m) => {
    const fn = cap(m, "func")?.text ?? "";
    return fn === "library" || fn === "require";
  });
  if (importMatches.length > 0) {
    const nodes = importMatches
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
    for (const m of importMatches) {
      const raw = cap(m, "module")?.text ?? "";
      // strip surrounding quotes
      const mod = raw.replace(/^["']|["']$/g, "");
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
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumb = `# ${capitalize(type)}: ${name}`;
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
      metadata: { breadcrumb },
    });
  };

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (fnNode && name) addChunk(fnNode, name, "function");
  }

  // --- S4 class system: setClass / setMethod / setGeneric ---
  for (const m of getMatches("callExpressions")) {
    const callee = cap(m, "callee")?.text ?? "";
    if (!S4_CALL_NAMES.has(callee)) continue;
    const callCap = cap(m, "call");
    if (!callCap?.node) continue;
    const text = callCap.text ?? "";
    // First arg is the class/method/generic name as a string literal
    const nameMatch = text.match(
      /^set(?:Class|Method|Generic)\s*\(\s*["']([^"']+)["']/,
    );
    const name = nameMatch?.[1] ?? "";
    if (!name) continue;
    const type: ChunkType =
      callee === "setClass"
        ? "class"
        : callee === "setMethod"
          ? "method"
          : "function";
    addChunk(callCap.node, name, type);
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

  // CALLS edges
  for (const m of getMatches("callExpressions")) {
    const callee = cap(m, "callee")?.text ?? "";
    const callNode = cap(m, "call")?.node;
    if (!callee || !callNode) continue;
    const enclosing = chunks.find(
      (c) =>
        (c.type === "function" || c.type === "method") &&
        c.startLine <= callNode.startRow + 1 &&
        c.endLine >= callNode.endRow + 1,
    );
    rawEdges.push({
      sourceChunkId: enclosing?.id ?? "",
      sourceFilePath: filePath,
      type: "CALLS",
      targetSymbol: callee,
      metadata: {},
    });
  }

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges };
}
