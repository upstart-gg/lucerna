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

const SCALA_QUERIES = {
  imports: `(import_declaration) @imp`,
  classes: `(class_definition name: (identifier) @name) @cls`,
  objects: `(object_definition name: (identifier) @name) @obj`,
  traits: `(trait_definition name: (identifier) @name) @trait`,
  functions: `(function_definition name: (identifier) @name) @fn`,
  callExpressions: `(call_expression function: (identifier) @callee) @call`,
};

// Scala 3 additions — grammar support varies; each query runs in its own try
// so one unsupported pattern doesn't kill the rest.
const SCALA_EXTRA_QUERIES = {
  enums: `(enum_definition name: (identifier) @name) @enum`,
  typeAliases: `(type_definition name: (type_identifier) @name) @alias`,
  givens: `(given_definition name: (identifier) @name) @given`,
};

const SCALA_INHERIT_QUERIES = {
  extends: `(class_definition name: (identifier) @name (extends_clause (type_identifier) @base)) @cls`,
};

export function extractScala(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "scala";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(SCALA_QUERIES).map(([k, q]) => [
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
      const mod = raw.replace(/^import\s+/, "").trim();
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
    const text = cap(m, "cls")?.text ?? "";
    if (node && name) {
      const isCase = /^\s*(?:[a-z]+\s+)*case\s+class\b/.test(text);
      addChunk(node, name, isCase ? "record" : "class");
    }
  }

  for (const m of getMatches("objects")) {
    const node = cap(m, "obj")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "object");
  }

  for (const m of getMatches("traits")) {
    const node = cap(m, "trait")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "trait");
  }

  // Scala 3 optional captures — each query runs independently so one
  // unsupported pattern doesn't kill the rest.
  const tryExtra = (key: keyof typeof SCALA_EXTRA_QUERIES): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language: "scala",
        patterns: {
          [key]: { query: SCALA_EXTRA_QUERIES[key], captureOutput: "Full" },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };
  for (const m of tryExtra("enums")) {
    const node = cap(m, "enum")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "enum");
  }
  for (const m of tryExtra("typeAliases")) {
    const node = cap(m, "alias")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "typealias");
  }
  for (const m of tryExtra("givens")) {
    const node = cap(m, "given")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "instance");
  }

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "trait" ||
          chunk.type === "object" ||
          chunk.type === "record" ||
          chunk.type === "enum") &&
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
      language: "scala",
      patterns: Object.fromEntries(
        Object.entries(SCALA_INHERIT_QUERIES).map(([k, q]) => [
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
