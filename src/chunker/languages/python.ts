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

const PYTHON_QUERIES = {
  imports: `[(import_statement) (import_from_statement)] @imp`,
  classes: `(class_definition name: (identifier) @name) @cls`,
  functions: `(function_definition name: (identifier) @name) @fn`,
  callExpressions: `(call function: [(identifier) @callee (attribute attribute: (identifier) @callee)]) @call`,
};

const PYTHON_INHERIT_QUERIES = {
  extends: `(class_definition name: (identifier) @name bases: (argument_list (identifier) @base)) @cls`,
};

export function extractPython(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "python";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(PYTHON_QUERIES).map(([k, q]) => [
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
    for (const m of importMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      // "import os" → "os", "from os.path import join" → "os.path"
      let mod = raw.replace(/^from\s+(\S+)\s+import.*$/, "$1");
      if (mod === raw) mod = raw.replace(/^import\s+(\S+).*$/, "$1");
      mod = mod.trim();
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
    type: "class" | "function",
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

  for (const m of getMatches("classes")) {
    const node = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
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
    addChunk(fnNode, name, "function", parentName);
  }

  // --- EXTENDS edges ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const inh: any = packExtract(source, {
      language: "python",
      patterns: Object.fromEntries(
        Object.entries(PYTHON_INHERIT_QUERIES).map(([k, q]) => [
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
