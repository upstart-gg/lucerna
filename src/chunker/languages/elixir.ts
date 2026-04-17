import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const ELIXIR_QUERIES = {
  // defmodule MyModule do ... end
  modules: `(call target: (identifier) @def (arguments (alias) @name) (do_block)) @module`,
  // def / defp function definitions
  defs: `(call target: (identifier) @def (arguments (call target: (identifier) @name)) (do_block)) @fn`,
  // alias / import / use directives
  imports: `(call target: (identifier) @func (arguments (alias) @module)) @imp`,
  callExpressions: `(call target: (identifier) @callee) @call`,
};

export function extractElixir(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "elixir";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(ELIXIR_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (alias / import / use) ---
  let importContent = "";
  const importMatches = getMatches("imports").filter((m) => {
    const func = cap(m, "func")?.text ?? "";
    return func === "alias" || func === "import" || func === "use";
  });
  if (importMatches.length > 0) {
    const nodes = importMatches
      .map((m) => cap(m, "imp")?.node)
      .filter((n): n is NonNullable<typeof n> => n != null);
    const startLine = Math.min(...nodes.map((n) => n.startRow)) + 1;
    const endLine = Math.max(...nodes.map((n) => n.endRow)) + 1;
    importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
    const breadcrumb = `# File: ${filePath}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "import",
      content: importContent,
      contextContent: `${breadcrumb}\n\n${importContent}`,
      startLine,
      endLine,
      metadata: { breadcrumb },
    });
    for (const m of importMatches) {
      const mod = cap(m, "module")?.text ?? "";
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

  // Modules
  for (const m of getMatches("modules").filter(
    (m) => (cap(m, "def")?.text ?? "") === "defmodule",
  )) {
    const node = cap(m, "module")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!node || !name) continue;
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `# File: ${filePath}\n# Module: ${name}`;
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "class",
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  }

  // def / defp functions
  for (const m of getMatches("defs").filter((m) => {
    const def = cap(m, "def")?.text ?? "";
    return def === "def" || def === "defp";
  })) {
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
    const content = sourceLines
      .slice(fnNode.startRow, fnNode.endRow + 1)
      .join("\n");
    const breadcrumbParts = [`# File: ${filePath}`];
    if (parentName) breadcrumbParts.push(`# Module: ${parentName}`);
    breadcrumbParts.push(`# Function: ${name}`);
    const breadcrumb = breadcrumbParts.join("\n");
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: parentName ? "method" : "function",
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: fnNode.startRow + 1,
      endLine: fnNode.endRow + 1,
      metadata: parentName
        ? { className: parentName, breadcrumb }
        : { breadcrumb },
    });
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
