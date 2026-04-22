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

const OBJC_QUERIES = {
  includes: `(preproc_include) @imp`,
  interfaces: `(class_interface (identifier) @name) @cls`,
  impls: `(class_implementation (identifier) @name) @impl`,
  methDecls: `(method_declaration) @method`,
  methDefs: `(method_definition) @method`,
  calls: `(call_expression) @call`,
};

// Optional — some tree-sitter-objc grammars don't expose these nodes.
// Each runs in its own try/catch so a missing rule doesn't break the rest.
const OBJC_EXTRA_QUERIES = {
  protocols: `(protocol_declaration (identifier) @name) @p`,
  // Categories: `@interface NSString (X)` reuses class_interface with two ids.
  categories: `(class_interface (identifier) @cls (identifier) @cat) @ext`,
  // property_declaration has no exposed name capture; we regex it from text.
  properties: `(property_declaration) @prop`,
};

export function extractObjc(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "objc";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(OBJC_QUERIES).map(([k, q]) => [
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
  const includeMatches = getMatches("includes");
  if (includeMatches.length > 0) {
    const nodes = includeMatches
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
    for (const m of includeMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      const mod = raw.match(/#import\s+[<"]([^>"]+)[>"]/)?.[1] ?? "";
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

  // --- @interface declarations ---
  const seenIfaceRows = new Set<number>();
  for (const m of getMatches("interfaces")) {
    const clsNode = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!clsNode || !name) continue;
    if (seenIfaceRows.has(clsNode.startRow)) continue;
    seenIfaceRows.add(clsNode.startRow);
    addChunk(clsNode, name, "class");
  }

  // --- @implementation blocks ---
  const seenImplRows = new Set<number>();
  for (const m of getMatches("impls")) {
    const implNode = cap(m, "impl")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!implNode || !name) continue;
    if (seenImplRows.has(implNode.startRow)) continue;
    seenImplRows.add(implNode.startRow);
    if (!chunks.some((c) => c.type === "class" && c.name === name)) {
      addChunk(implNode, name, "class");
    }
  }

  // --- Protocols / categories / properties — grammar coverage varies, each
  // query runs independently so one unsupported pattern doesn't kill the rest.
  const tryExtra = (key: keyof typeof OBJC_EXTRA_QUERIES): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language,
        patterns: {
          [key]: { query: OBJC_EXTRA_QUERIES[key], captureOutput: "Full" },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };
  const seenProtoRows = new Set<number>();
  for (const m of tryExtra("protocols")) {
    const node = cap(m, "p")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!node || !name) continue;
    if (seenProtoRows.has(node.startRow)) continue;
    seenProtoRows.add(node.startRow);
    addChunk(node, name, "protocol");
  }
  const seenCatRows = new Set<number>();
  for (const m of tryExtra("categories")) {
    const node = cap(m, "ext")?.node;
    // For categories we want the category name (the second identifier), e.g.
    // `@interface NSString (Utils)` → "Utils". Use @cat capture; fall back
    // to the class name only if @cat is missing.
    const catName = cap(m, "cat")?.text ?? "";
    const clsName = cap(m, "cls")?.text ?? "";
    const name = catName || clsName;
    if (!node || !name) continue;
    if (seenCatRows.has(node.startRow)) continue;
    seenCatRows.add(node.startRow);
    addChunk(node, name, "extension");
  }
  for (const m of tryExtra("properties")) {
    const node = cap(m, "prop")?.node;
    if (!node) continue;
    const text = cap(m, "prop")?.text ?? "";
    // `@property (nonatomic) NSString *name;` → "name"
    const name = text.match(/(?:\*\s*|\s)(\w+)\s*;/)?.[1] ?? "";
    if (!name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "protocol" ||
          chunk.type === "extension") &&
        chunk.startLine <= node.startRow + 1 &&
        chunk.endLine >= node.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(node, name, "property", parentName);
  }

  // --- Method declarations (@interface) and definitions (@implementation) ---
  for (const key of ["methDecls", "methDefs"]) {
    for (const m of getMatches(key)) {
      const methodNode = cap(m, "method")?.node;
      if (!methodNode) continue;
      const text = cap(m, "method")?.text ?? "";
      const name = text.match(/^[-+]\s*\([^)]+\)\s*(\w+)/)?.[1] ?? "";
      if (!name) continue;
      let parentName: string | undefined;
      for (const chunk of chunks) {
        if (
          (chunk.type === "class" ||
            chunk.type === "protocol" ||
            chunk.type === "extension") &&
          chunk.startLine <= methodNode.startRow + 1 &&
          chunk.endLine >= methodNode.endRow + 1
        ) {
          parentName = chunk.name;
          break;
        }
      }
      addChunk(methodNode, name, "method", parentName);
    }
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

  // --- CALLS edges (C-style function calls) ---
  for (const m of getMatches("calls")) {
    const callNode = cap(m, "call")?.node;
    if (!callNode) continue;
    const text = cap(m, "call")?.text ?? "";
    const callee = text.match(/^(\w+)\s*\(/)?.[1] ?? "";
    if (!callee) continue;
    const enclosing = chunks.find(
      (c) =>
        (c.type === "method" || c.type === "function") &&
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
