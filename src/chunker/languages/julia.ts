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

const JULIA_QUERIES = {
  imports: `[(import_statement) (using_statement)] @imp`,
  functions: `(function_definition) @fn`,
  structs: `(struct_definition) @struct`,
  modules: `(module_definition name: (identifier) @name) @mod`,
  calls: `(call_expression) @call`,
};

const JULIA_EXTRA_QUERIES = {
  macros: `(macro_definition) @macro`,
  abstractTypes: `(abstract_definition) @abs`,
  consts: `(const_statement) @const`,
};

const MIN_CONST_CHARS = 40;

export function extractJulia(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "julia";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(JULIA_QUERIES).map(([k, q]) => [
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
        .replace(/^(?:using|import)\s+/, "")
        .split(/[,\s]/)[0]
        ?.trim();
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
    if (parentName) breadcrumbParts.push(`# Module: ${parentName}`);
    breadcrumbParts.push(`# ${capitalize(type)}: ${name}`);
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

  // --- Modules ---
  for (const m of getMatches("modules")) {
    const node = cap(m, "mod")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "module");
  }

  // --- Functions ---
  for (const m of getMatches("functions")) {
    const node = cap(m, "fn")?.node;
    if (!node) continue;
    const text = cap(m, "fn")?.text ?? "";
    const name = text.match(/^function\s+(\w+)/)?.[1] ?? "";
    if (!name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        chunk.type === "module" &&
        chunk.startLine <= node.startRow + 1 &&
        chunk.endLine >= node.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(node, name, parentName ? "method" : "function", parentName);
  }

  // --- Structs ---
  for (const m of getMatches("structs")) {
    const node = cap(m, "struct")?.node;
    if (!node) continue;
    const text = cap(m, "struct")?.text ?? "";
    const name = text.match(/(?:mutable\s+)?struct\s+(\w+)/)?.[1] ?? "";
    if (!name) continue;
    addChunk(node, name, "struct");
  }

  // --- Macros / abstract types / consts ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(JULIA_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    const exM = (key: string) => exR[key]?.matches ?? [];
    for (const m of exM("macros")) {
      const node = cap(m, "macro")?.node;
      if (!node) continue;
      const text = cap(m, "macro")?.text ?? "";
      const name = text.match(/^macro\s+(\w+)/)?.[1] ?? "";
      if (name) addChunk(node, name, "macro");
    }
    for (const m of exM("abstractTypes")) {
      const node = cap(m, "abs")?.node;
      if (!node) continue;
      const text = cap(m, "abs")?.text ?? "";
      const name = text.match(/abstract\s+type\s+(\w+)/)?.[1] ?? "";
      if (name) addChunk(node, name, "type");
    }
    for (const m of exM("consts")) {
      const node = cap(m, "const")?.node;
      if (!node) continue;
      const text = cap(m, "const")?.text ?? "";
      const name = text.match(/^const\s+(\w+)\s*=/)?.[1] ?? "";
      if (!name) continue;
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      if (content.length < MIN_CONST_CHARS) continue;
      addChunk(node, name, "const");
    }
  } catch {
    /* Julia extras unsupported — skip */
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

  // --- CALLS edges ---
  for (const m of getMatches("calls")) {
    const callNode = cap(m, "call")?.node;
    if (!callNode) continue;
    const text = cap(m, "call")?.text ?? "";
    const callee = text.match(/^(\w+)\s*[({[\s]/)?.[1] ?? "";
    if (!callee) continue;
    const enclosing = chunks.find(
      (c) =>
        (c.type === "function" || c.type === "method" || c.type === "macro") &&
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
