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

const SOLIDITY_QUERIES = {
  imports: `(import_directive (string) @module) @imp`,
  contracts: `(contract_declaration name: (identifier) @name) @cls`,
  interfaces: `(interface_declaration name: (identifier) @name) @iface`,
  functions: `(function_definition name: (identifier) @name) @fn`,
  events: `(event_definition name: (identifier) @name) @event`,
  modifiers: `(modifier_definition name: (identifier) @name) @modifier`,
  callExpressions: `(call_expression (expression (identifier) @callee)) @call`,
};

// Solidity grammar coverage varies across pack versions; run extras separately
const SOLIDITY_EXTRA_QUERIES = {
  libraries: `(library_declaration name: (identifier) @name) @lib`,
  structs: `(struct_declaration name: (identifier) @name) @struct`,
  enums: `(enum_declaration name: (identifier) @name) @enum`,
  stateVariables: `(state_variable_declaration name: (identifier) @name) @sv`,
  errors: `(error_declaration name: (identifier) @name) @err`,
};

const SOLIDITY_INHERIT_QUERIES = {
  extends: `(contract_declaration name: (identifier) @name (inheritance_specifier (user_defined_type (identifier) @base))) @cls`,
};

const MIN_STATE_VAR_CHARS = 30;

export function extractSolidity(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "solidity";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(SOLIDITY_QUERIES).map(([k, q]) => [
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
      const raw = cap(m, "module")?.text ?? "";
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
    parentName?: string,
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumbParts: string[] = [];
    if (parentName) breadcrumbParts.push(`// Contract: ${parentName}`);
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
      startLine: startRow + 1,
      endLine: node.endRow + 1,
      metadata: parentName
        ? { className: parentName, breadcrumb }
        : { breadcrumb },
    });
  };

  for (const m of getMatches("contracts")) {
    const node = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
  }

  for (const m of getMatches("interfaces")) {
    const node = cap(m, "iface")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "interface");
  }

  for (const m of getMatches("events")) {
    const node = cap(m, "event")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "event");
  }

  for (const m of getMatches("modifiers")) {
    const node = cap(m, "modifier")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "modifier");
  }

  // Solidity extras — grammar coverage varies
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language: "solidity",
      patterns: Object.fromEntries(
        Object.entries(SOLIDITY_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    const exM = (key: string) => exR[key]?.matches ?? [];
    for (const m of exM("libraries")) {
      const node = cap(m, "lib")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "library");
    }
    for (const m of exM("structs")) {
      const node = cap(m, "struct")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "struct");
    }
    for (const m of exM("enums")) {
      const node = cap(m, "enum")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "enum");
    }
    for (const m of exM("errors")) {
      const node = cap(m, "err")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "error");
    }
    for (const m of exM("stateVariables")) {
      const node = cap(m, "sv")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (!node || !name) continue;
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      if (content.length < MIN_STATE_VAR_CHARS) continue;
      let parentName: string | undefined;
      for (const chunk of chunks) {
        if (
          (chunk.type === "class" || chunk.type === "interface") &&
          chunk.startLine <= node.startRow + 1 &&
          chunk.endLine >= node.endRow + 1
        ) {
          parentName = chunk.name;
          break;
        }
      }
      addChunk(node, name, "state_variable", parentName);
    }
  } catch {
    /* Solidity extras unsupported in this grammar — skip */
  }

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "interface" ||
          chunk.type === "library") &&
        chunk.startLine <= fnNode.startRow + 1 &&
        chunk.endLine >= fnNode.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(fnNode, name, parentName ? "method" : "function", parentName);
  }

  // --- EXTENDS edges ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const inh: any = packExtract(source, {
      language: "solidity",
      patterns: Object.fromEntries(
        Object.entries(SOLIDITY_INHERIT_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const inhResults = inh.results as Record<
      string,
      { matches: PatternMatch[] }
    >;
    const inhMatches = (key: string): PatternMatch[] =>
      inhResults[key]?.matches ?? [];
    for (const m of inhMatches("extends")) {
      const nameNode = cap(m, "name");
      const baseNode = cap(m, "base");
      if (!nameNode?.node || !baseNode?.text) continue;
      const nameRow = nameNode.node.startRow;
      const classChunk = chunks.find(
        (c) => c.startLine === nameRow + 1 && c.type === "class",
      );
      rawEdges.push({
        sourceChunkId: classChunk?.id ?? "",
        sourceFilePath: filePath,
        type: "EXTENDS",
        targetSymbol: baseNode.text,
        metadata: {},
      });
    }
  } catch {
    /* inheritance query unsupported — skip edges */
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
