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

const BASH_QUERIES = {
  // source and . (dot) commands for importing other scripts
  sources: `(command name: (command_name (word) @cmd) (word) @module) @imp`,
  functions: `(function_definition name: (word) @name) @fn`,
  callExpressions: `(command name: (command_name (word) @callee)) @call`,
};

const BASH_EXTRA_QUERIES = {
  variables: `(variable_assignment name: (variable_name) @name) @var`,
};

const MIN_CONST_CHARS = 40;

export function extractBash(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "bash";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(BASH_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (source / . commands) ---
  let importContent = "";
  const sourceMatches = getMatches("sources").filter((m) => {
    const cmd = cap(m, "cmd")?.text ?? "";
    return cmd === "source" || cmd === ".";
  });
  if (sourceMatches.length > 0) {
    const nodes = sourceMatches
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
    for (const m of sourceMatches) {
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

  // --- Top-level variable assignments ≥ 40 chars → const ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(BASH_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    for (const m of exR.variables?.matches ?? []) {
      const node = cap(m, "var")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (!node || !name) continue;
      // Only top-level: not inside a function chunk
      const insideFn = chunks.some(
        (c) =>
          c.type === "function" &&
          c.startLine <= node.startRow + 1 &&
          c.endLine >= node.endRow + 1,
      );
      if (insideFn) continue;
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      if (content.length < MIN_CONST_CHARS) continue;
      addChunk(node, name, "const");
    }
  } catch {
    /* Bash variable capture unsupported — skip */
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
