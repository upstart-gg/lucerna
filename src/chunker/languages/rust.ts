import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  capitalize,
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const RUST_QUERIES = {
  uses: `(use_declaration) @imp`,
  functions: `(function_item name: (identifier) @name) @fn`,
  structs: `(struct_item name: (type_identifier) @name) @struct`,
  enums: `(enum_item name: (type_identifier) @name) @enum`,
  traits: `(trait_item name: (type_identifier) @name) @trait`,
  impls: `(impl_item type: (type_identifier) @name) @impl`,
  callExpressions: `(call_expression function: [(identifier) @callee (field_expression field: (field_identifier) @callee)]) @call`,
};

export function extractRust(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "rust";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(RUST_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (use declarations) ---
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
      const raw = cap(m, "imp")?.text ?? "";
      // "use std::collections::HashMap;" → "std::collections::HashMap"
      const mod = raw
        .replace(/^use\s+/, "")
        .replace(/;$/, "")
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

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: "class" | "interface" | "type" | "function",
    parentName?: string,
  ) => {
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumbParts: string[] = [];
    if (parentName) breadcrumbParts.push(`// Impl: ${parentName}`);
    breadcrumbParts.push(`// ${capitalize(type)}: ${name}`);
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
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: parentName
        ? { className: parentName, breadcrumb }
        : { breadcrumb },
    });
  };

  // Track claimed rows so impl methods don't double-register as top-level functions
  const claimedRows = new Set<number>();

  for (const m of getMatches("structs")) {
    const node = cap(m, "struct")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
  }

  for (const m of getMatches("enums")) {
    const node = cap(m, "enum")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "type");
  }

  for (const m of getMatches("traits")) {
    const node = cap(m, "trait")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "interface");
  }

  for (const m of getMatches("impls")) {
    const node = cap(m, "impl")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) {
      claimedRows.add(node.startRow);
      addChunk(node, name, "class");
    }
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
    if (!claimedRows.has(fnNode.startRow))
      addChunk(fnNode, name, "function", parentName);
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
