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

// tree-sitter-powershell exposes `function_name`/`simple_name`/`command_name`
// as positional children (no named fields). `using_statement` and other
// optional rules vary across grammar versions, so they live in EXTRA queries
// that run independently to avoid taking down the whole batch.
const POWERSHELL_QUERIES = {
  functions: `(function_statement (function_name) @name) @fn`,
  classes: `(class_statement (simple_name) @name) @cls`,
  callExpressions: `(command (command_name) @callee) @call`,
};

const POWERSHELL_EXTRA_QUERIES = {
  imports: `(using_statement) @imp`,
  paramBlocks: `(param_block) @param`,
};

export function extractPowerShell(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "powershell";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(POWERSHELL_QUERIES).map(([k, q]) => [
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

  // Per-key tryExtra: run optional EXTRA queries independently so a missing
  // node type doesn't take down the rest.
  const tryExtra = (
    key: keyof typeof POWERSHELL_EXTRA_QUERIES,
  ): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language,
        patterns: {
          [key]: {
            query: POWERSHELL_EXTRA_QUERIES[key],
            captureOutput: "Full",
          },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };

  // --- Import chunk (using statements — optional, grammar coverage varies) ---
  let importContent = "";
  const usingMatches = tryExtra("imports");
  if (usingMatches.length > 0) {
    const nodes = usingMatches
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
    for (const m of usingMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      // "using module MyModule" → "MyModule"
      const mod = raw
        .replace(/^using\s+(?:module|assembly|namespace)\s+/i, "")
        .trim();
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
    if (parentName) breadcrumbParts.push(`# Class: ${parentName}`);
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

  for (const m of getMatches("classes")) {
    const node = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
  }

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        chunk.type === "class" &&
        chunk.startLine <= fnNode.startRow + 1 &&
        chunk.endLine >= fnNode.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(fnNode, name, parentName ? "method" : "function", parentName);
  }

  // --- Param blocks (only script-scope) ---
  for (const m of tryExtra("paramBlocks")) {
    const node = cap(m, "param")?.node;
    if (!node) continue;
    const insideFn = chunks.some(
      (c) =>
        (c.type === "function" || c.type === "method" || c.type === "class") &&
        c.startLine <= node.startRow + 1 &&
        c.endLine >= node.endRow + 1,
    );
    if (insideFn) continue;
    addChunk(node, "param", "param_block");
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
