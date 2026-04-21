import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  capitalize,
  mergeSiblingChunks,
  packExtract,
  packProcess,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const GO_QUERIES = {
  functions: `(function_declaration name: (identifier) @name) @fn`,
  methods: `(method_declaration receiver: (parameter_list (parameter_declaration type: [(pointer_type (type_identifier) @receiver) (type_identifier) @receiver])) name: (field_identifier) @name) @method`,
  structs: `(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @struct`,
  interfaces: `(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @interface`,
  typedefs: `(type_declaration (type_spec name: (type_identifier) @name)) @typedef`,
  aliases: `(type_alias name: (type_identifier) @name) @alias`,
  callExpressions: `(call_expression function: [(identifier) @callee (selector_expression field: (field_identifier) @callee)]) @call`,
};

export function extractGo(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");

  // Get imports via process() — Go import blocks need span coverage
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape differs from types
  let procResult: any;
  try {
    procResult = packProcess(source, { language: "go", imports: true });
  } catch {
    procResult = { imports: [] };
  }

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language: "go",
      patterns: Object.fromEntries(
        Object.entries(GO_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return processWithPack(source, filePath, projectId, "go", minMergeChars);
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

  // --- Import chunk from process() ---
  let importContent = "";
  const importInfos: Array<{
    source: string;
    span: { startLine: number; endLine: number };
  }> = procResult.imports ?? [];
  if (importInfos.length > 0) {
    const startLine = Math.min(...importInfos.map((i) => i.span.startLine)) + 1;
    const endLine = Math.max(...importInfos.map((i) => i.span.endLine)) + 1;
    importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "go",
      type: "import",
      content: importContent,
      contextContent: importContent,
      startLine,
      endLine,
      metadata: {},
    });
    for (const imp of importInfos) {
      if (imp.source.includes("\n")) continue; // skip block wrapper
      const mod = imp.source.trim().match(/^(?:[._\w]+\s+)?"([^"]+)"$/)?.[1];
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
    type: "function" | "method" | "class" | "interface" | "type",
    parentName?: string,
  ) => {
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumbParts: string[] = [];
    if (parentName) breadcrumbParts.push(`// Class: ${parentName}`);
    breadcrumbParts.push(`// ${capitalize(type)}: ${name}`);
    const breadcrumb = breadcrumbParts.join("\n");
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "go",
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

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (fnNode && name) addChunk(fnNode, name, "function");
  }

  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    const receiver = cap(m, "receiver")?.text ?? undefined;
    if (methodNode && name) addChunk(methodNode, name, "method", receiver);
  }

  for (const m of getMatches("structs")) {
    const structNode = cap(m, "struct")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (structNode && name) addChunk(structNode, name, "class");
  }

  for (const m of getMatches("interfaces")) {
    const ifaceNode = cap(m, "interface")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (ifaceNode && name) addChunk(ifaceNode, name, "interface");
  }

  // typedefs query matches ALL type_declarations including structs and interfaces.
  // Deduplicate: skip rows already claimed by struct or interface matches.
  const claimedRows = new Set<number>();
  for (const m of [...getMatches("structs"), ...getMatches("interfaces")]) {
    const n = (cap(m, "struct") ?? cap(m, "interface"))?.node;
    if (n) claimedRows.add(n.startRow);
  }
  for (const m of getMatches("typedefs")) {
    const typeNode = cap(m, "typedef")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (typeNode && name && !claimedRows.has(typeNode.startRow))
      addChunk(typeNode, name, "type");
  }

  for (const m of getMatches("aliases")) {
    const aliasNode = cap(m, "alias")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (aliasNode && name) addChunk(aliasNode, name, "type");
  }

  if (chunks.length === 0) {
    return processWithPack(source, filePath, projectId, "go", minMergeChars);
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
