import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const ERLANG_QUERIES = {
  moduleAttr: `(module_attribute) @attr`,
  exportAttr: `(export_attribute) @attr`,
  fns: `(fun_decl) @fn`,
  calls: `(call) @call`,
};

export function extractErlang(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "erlang";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(ERLANG_QUERIES).map(([k, q]) => [
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

  // --- Import chunk from -module() and -export() attributes ---
  let importContent = "";
  const attrMatches = [
    ...getMatches("moduleAttr"),
    ...getMatches("exportAttr"),
  ].sort((a, b) => {
    const aRow = cap(a, "attr")?.node?.startRow ?? 0;
    const bRow = cap(b, "attr")?.node?.startRow ?? 0;
    return aRow - bRow;
  });

  if (attrMatches.length > 0) {
    const nodes = attrMatches
      .map((m) => cap(m, "attr")?.node)
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
    for (const m of getMatches("moduleAttr")) {
      const raw = cap(m, "attr")?.text ?? "";
      // "-module(hello)." → "hello"
      const mod = raw.match(/-module\s*\(\s*(\w+)\s*\)/)?.[1];
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

  // --- Functions ---
  const seenFnNames = new Set<string>();
  for (const m of getMatches("fns")) {
    const node = cap(m, "fn")?.node;
    if (!node) continue;
    const text = cap(m, "fn")?.text ?? "";
    // Function name is always the first atom before "("
    const name = text.match(/^(\w+)\s*\(/)?.[1] ?? "";
    if (!name) continue;
    // Deduplicate: Erlang fun_decl is already per-function, but guard just in case
    if (seenFnNames.has(`${node.startRow}:${name}`)) continue;
    seenFnNames.add(`${node.startRow}:${name}`);
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `% Function: ${name}`;
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "function",
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
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

  // --- CALLS edges ---
  for (const m of getMatches("calls")) {
    const callNode = cap(m, "call")?.node;
    if (!callNode) continue;
    const text = cap(m, "call")?.text ?? "";
    // Local call: "func(args)" → "func"; remote: "mod:func(args)" → "mod:func"
    const callee =
      text.match(/^(\w+:\w+)\s*\(/)?.[1] ??
      text.match(/^(\w+)\s*\(/)?.[1] ??
      "";
    if (!callee) continue;
    const enclosing = chunks.find(
      (c) =>
        c.type === "function" &&
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
