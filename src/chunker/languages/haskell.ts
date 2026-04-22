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

const HASKELL_QUERIES = {
  imports: `(import) @imp`,
  functions: `(function (variable) @name) @fn`,
  datatypes: `(data_type (name) @name) @type`,
  typeclasses: `(class (name) @name) @cls`,
  // tree-sitter-haskell uses `apply` (not `apply_expression`); function name
  // is the first child but lacks a clean field, so we regex it from text.
  callExpressions: `(apply) @call`,
};

// tree-sitter-haskell uses the (typo'd) node name `type_synomym` for type
// aliases; querying `type_alias` throws. Each EXTRA runs independently so a
// missing rule doesn't kill the rest.
const HASKELL_EXTRA_QUERIES = {
  instances: `(instance (name) @name) @inst`,
  newtypes: `(newtype (name) @name) @nt`,
  typeAliases: `(type_synomym (name) @name) @alias`,
};

export function extractHaskell(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "haskell";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(HASKELL_QUERIES).map(([k, q]) => [
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

  // --- Import chunk ---
  let importContent = "";
  const importMatches = getMatches("imports");
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
      const raw = cap(m, "imp")?.text ?? "";
      const mod = raw
        .replace(/^import\s+(?:qualified\s+)?(\S+).*$/, "$1")
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
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumb = `-- ${capitalize(type)}: ${name}`;
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

  const seenFns = new Set<string>();
  for (const m of getMatches("functions")) {
    const node = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name && !seenFns.has(name)) {
      seenFns.add(name);
      addChunk(node, name, "function");
    }
  }

  for (const m of getMatches("datatypes")) {
    const node = cap(m, "type")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "type");
  }

  for (const m of getMatches("typeclasses")) {
    const node = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
  }

  // Per-key tryExtra: a single bad query in a batch throws the whole batch and
  // silently falls through, so each EXTRA runs in its own try/catch.
  const tryExtra = (
    key: keyof typeof HASKELL_EXTRA_QUERIES,
  ): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language,
        patterns: {
          [key]: { query: HASKELL_EXTRA_QUERIES[key], captureOutput: "Full" },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };
  for (const m of tryExtra("instances")) {
    const node = cap(m, "inst")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "instance");
  }
  for (const m of tryExtra("newtypes")) {
    const node = cap(m, "nt")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "newtype");
  }
  const seenAliasRows = new Set<number>();
  for (const m of tryExtra("typeAliases")) {
    const node = cap(m, "alias")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!node || !name) continue;
    if (seenAliasRows.has(node.startRow)) continue;
    seenAliasRows.add(node.startRow);
    addChunk(node, name, "typealias");
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

  // CALLS edges — `apply` exposes the callee as the leftmost identifier in the
  // node's text, so regex it out.
  for (const m of getMatches("callExpressions")) {
    const callNode = cap(m, "call")?.node;
    if (!callNode) continue;
    const text = cap(m, "call")?.text ?? "";
    const callee = text.match(/^([A-Za-z_][\w']*)/)?.[1] ?? "";
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
