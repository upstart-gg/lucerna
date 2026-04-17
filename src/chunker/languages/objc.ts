import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
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
    for (const m of includeMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      // Extract path: #import <Foundation/Foundation.h> or #import "MyClass.h"
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

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: "class" | "method",
    parentName?: string,
  ) => {
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumbParts = [`// File: ${filePath}`];
    if (parentName) breadcrumbParts.push(`// Class: ${parentName}`);
    breadcrumbParts.push(
      `// ${type === "class" ? "Class" : "Method"}: ${name}`,
    );
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

  // --- @interface declarations ---
  // (class_interface (identifier) @name) matches BOTH class name and superclass;
  // we deduplicate by cls node startRow and take only the first @name per node.
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
    // Only add if we don't already have a class chunk for this name from @interface
    if (!chunks.some((c) => c.type === "class" && c.name === name)) {
      addChunk(implNode, name, "class");
    }
  }

  // --- Method declarations (@interface) and definitions (@implementation) ---
  for (const key of ["methDecls", "methDefs"]) {
    for (const m of getMatches(key)) {
      const methodNode = cap(m, "method")?.node;
      if (!methodNode) continue;
      const text = cap(m, "method")?.text ?? "";
      // "- (void)greet:(NSString *)name" → "greet"
      const name = text.match(/^[-+]\s*\([^)]+\)\s*(\w+)/)?.[1] ?? "";
      if (!name) continue;
      // Find enclosing class (interface or impl)
      let parentName: string | undefined;
      for (const chunk of chunks) {
        if (
          chunk.type === "class" &&
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
