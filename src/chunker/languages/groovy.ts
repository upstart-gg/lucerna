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

const GROOVY_QUERIES = {
  imports: `(import_declaration) @imp`,
  classes: `(class_declaration name: (identifier) @name) @cls`,
  methods: `(method_declaration name: (identifier) @name) @method`,
  callExpressions: `(method_invocation name: (identifier) @callee) @call`,
};

const GROOVY_EXTRA_QUERIES = {
  closures: `(local_variable_declaration (variable_declarator name: (identifier) @name value: (closure))) @decl`,
};

export function extractGroovy(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "groovy";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(GROOVY_QUERIES).map(([k, q]) => [
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
        .replace(/^import\s+(?:static\s+)?/, "")
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

  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!methodNode || !name) continue;
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

  // --- Top-level closures: def name = { ... } ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(GROOVY_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    for (const m of exR.closures?.matches ?? []) {
      const node = cap(m, "decl")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (!node || !name) continue;
      // Only treat as a function if not already inside a class chunk
      const insideClass = chunks.some(
        (c) =>
          c.type === "class" &&
          c.startLine <= node.startRow + 1 &&
          c.endLine >= node.endRow + 1,
      );
      if (insideClass) continue;
      addChunk(node, name, "function");
    }
  } catch {
    /* Groovy closure capture unsupported — skip */
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
