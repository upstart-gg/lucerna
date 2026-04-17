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

const CSHARP_QUERIES = {
  usings: `(using_directive) @imp`,
  classes: `(class_declaration name: (identifier) @name) @cls`,
  records: `(record_declaration name: (identifier) @name) @cls`,
  structs: `(struct_declaration name: (identifier) @name) @cls`,
  interfaces: `(interface_declaration name: (identifier) @name) @iface`,
  enums: `(enum_declaration name: (identifier) @name) @enum`,
  methods: `(method_declaration name: (identifier) @name) @method`,
  callExpressions: `(invocation_expression function: [(identifier) @callee (member_access_expression name: (identifier) @callee)]) @call`,
};

// Inheritance queries run separately (own try/catch) to avoid breaking structure extraction
const CSHARP_INHERIT_QUERIES = {
  // base_list contains both parent class and implemented interfaces
  bases: `(class_declaration name: (identifier) @name (base_list (identifier) @base)) @cls`,
};

export function extractCSharp(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "csharp";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(CSHARP_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (using directives) ---
  let importContent = "";
  const usingMatches = getMatches("usings");
  if (usingMatches.length > 0) {
    const nodes = usingMatches
      .map((m) => cap(m, "imp")?.node)
      .filter((n): n is NonNullable<typeof n> => n != null);
    const startLine = Math.min(...nodes.map((n) => n.startRow)) + 1;
    const endLine = Math.max(...nodes.map((n) => n.endRow)) + 1;
    importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
    const breadcrumb = `// File: ${filePath}`;
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
    for (const m of usingMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      // "using System.IO;" → "System.IO"
      // "using static System.Math;" → "System.Math"
      // "using IO = System.IO;" → "System.IO"
      let mod = raw
        .replace(/^using\s+/, "")
        .replace(/;$/, "")
        .trim();
      mod = mod.replace(/^static\s+/, "");
      const aliasIdx = mod.indexOf(" = ");
      if (aliasIdx !== -1) mod = mod.slice(aliasIdx + 3).trim();
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
    type: "class" | "interface" | "type" | "method",
    parentName?: string,
  ) => {
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumbParts = [`// File: ${filePath}`];
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

  for (const key of ["classes", "records", "structs"] as const) {
    for (const m of getMatches(key)) {
      const node = cap(m, "cls")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "class");
    }
  }

  for (const m of getMatches("interfaces")) {
    const node = cap(m, "iface")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "interface");
  }

  for (const m of getMatches("enums")) {
    const node = cap(m, "enum")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "type");
  }

  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!methodNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" || chunk.type === "interface") &&
        chunk.startLine <= methodNode.startRow + 1 &&
        chunk.endLine >= methodNode.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(methodNode, name, "method", parentName);
  }

  // --- EXTENDS edges (separate extraction to avoid breaking structure queries) ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const inh: any = packExtract(source, {
      language: "csharp",
      patterns: Object.fromEntries(
        Object.entries(CSHARP_INHERIT_QUERIES).map(([k, q]) => [
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
    for (const m of inhMatches("bases")) {
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
