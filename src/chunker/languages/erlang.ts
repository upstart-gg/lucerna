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

const ERLANG_QUERIES = {
  moduleAttr: `(module_attribute) @attr`,
  exportAttr: `(export_attribute) @attr`,
  fns: `(fun_decl) @fn`,
  calls: `(call) @call`,
};

const ERLANG_EXTRA_QUERIES = {
  records: `(record_decl name: (atom) @name) @rec`,
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
    const breadcrumb = `% ${capitalize(type)}: ${name}`;
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

  // --- Records (-record(name, {...}).) ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(ERLANG_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    for (const m of exR.records?.matches ?? []) {
      const node = cap(m, "rec")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "record");
    }
  } catch {
    /* Erlang extras unsupported — skip */
  }

  // --- Functions ---
  const seenFnNames = new Set<string>();
  for (const m of getMatches("fns")) {
    const node = cap(m, "fn")?.node;
    if (!node) continue;
    const text = cap(m, "fn")?.text ?? "";
    const name = text.match(/^(\w+)\s*\(/)?.[1] ?? "";
    if (!name) continue;
    if (seenFnNames.has(`${node.startRow}:${name}`)) continue;
    seenFnNames.add(`${node.startRow}:${name}`);
    addChunk(node, name, "function");
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
