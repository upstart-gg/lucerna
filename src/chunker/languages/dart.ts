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

const DART_QUERIES = {
  imports: `(import_specification (configurable_uri (uri) @module)) @imp`,
  classes: `(class_definition name: (identifier) @name) @cls`,
  functions: `(function_signature name: (identifier) @name) @fn`,
  methods: `(method_signature (function_signature name: (identifier) @name)) @method`,
};

// Dart grammar node names vary across pack versions; run extras separately
// so a missing rule doesn't invalidate the core extraction.
const DART_EXTRA_QUERIES = {
  mixins: `(mixin_declaration (identifier) @name) @mx`,
  extensions: `(extension_declaration name: (identifier) @name) @ext`,
  enums: `(enum_declaration name: (identifier) @name) @enum`,
  typedefs: `(type_alias (type_identifier) @name) @alias`,
};

const DART_INHERIT_QUERIES = {
  extends: `(class_definition name: (identifier) @name (superclass (type_identifier) @base)) @cls`,
};

export function extractDart(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "dart";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(DART_QUERIES).map(([k, q]) => [
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
      // strip surrounding quotes
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
    if (node && name) addChunk(node, name, "class");
  }

  // Dart extras — grammar coverage varies across pack versions; each query
  // runs independently so one unsupported pattern doesn't kill the rest.
  const tryExtra = (key: keyof typeof DART_EXTRA_QUERIES): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language: "dart",
        patterns: {
          [key]: { query: DART_EXTRA_QUERIES[key], captureOutput: "Full" },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };
  for (const m of tryExtra("mixins")) {
    const node = cap(m, "mx")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "mixin");
  }
  for (const m of tryExtra("extensions")) {
    const node = cap(m, "ext")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "extension");
  }
  for (const m of tryExtra("enums")) {
    const node = cap(m, "enum")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "enum");
  }
  // type_alias has no `name:` field in the Dart grammar; the query matches
  // every type_identifier child, so pick the first one per alias node.
  const seenAliasRows = new Set<number>();
  for (const m of tryExtra("typedefs")) {
    const node = cap(m, "alias")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!node || !name) continue;
    if (seenAliasRows.has(node.startRow)) continue;
    seenAliasRows.add(node.startRow);
    addChunk(node, name, "typealias");
  }

  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "mixin" ||
          chunk.type === "extension" ||
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

  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!methodNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "mixin" ||
          chunk.type === "extension" ||
          chunk.type === "enum") &&
        chunk.startLine <= methodNode.startRow + 1 &&
        chunk.endLine >= methodNode.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(methodNode, name, "method", parentName);
  }

  // --- EXTENDS edges ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const inh: any = packExtract(source, {
      language: "dart",
      patterns: Object.fromEntries(
        Object.entries(DART_INHERIT_QUERIES).map(([k, q]) => [
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

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges };
}
