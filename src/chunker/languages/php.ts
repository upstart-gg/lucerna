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

const PHP_QUERIES = {
  uses: `(namespace_use_declaration) @imp`,
  functions: `(function_definition name: (name) @name) @fn`,
  classes: `(class_declaration name: (name) @name) @cls`,
  interfaces: `(interface_declaration name: (name) @name) @iface`,
  traits: `(trait_declaration name: (name) @name) @trait`,
  methods: `(method_declaration name: (name) @name) @method`,
  callExpressions: `(function_call_expression function: [(name) @callee (member_call_expression name: (name) @callee)]) @call`,
};

// PHP 8+ constructs — grammar coverage varies
const PHP_EXTRA_QUERIES = {
  enums: `(enum_declaration name: (name) @name) @enum`,
  consts: `(const_declaration (const_element (name) @name)) @const`,
  properties: `(property_declaration (property_element (variable_name (name) @name))) @prop`,
};

const PHP_INHERIT_QUERIES = {
  extends: `(class_declaration name: (name) @name (base_clause (name) @base)) @cls`,
  implements: `(class_declaration name: (name) @name (class_interface_clause (name) @iface)) @cls`,
};

const MIN_CONST_CHARS = 40;

export function extractPhp(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "php";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(PHP_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (use declarations) ---
  let importContent = "";
  const useMatches = getMatches("uses");
  if (useMatches.length > 0) {
    const nodes = useMatches
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
    for (const m of useMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      let mod = raw
        .replace(/^use\s+/, "")
        .replace(/;$/, "")
        .trim();
      mod = mod.replace(/^(?:function|const)\s+/, "");
      const asIdx = mod.lastIndexOf(" as ");
      if (asIdx !== -1) mod = mod.slice(0, asIdx).trim();
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

  for (const m of getMatches("functions")) {
    const node = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "function");
  }

  for (const m of getMatches("classes")) {
    const node = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "class");
  }

  for (const m of getMatches("interfaces")) {
    const node = cap(m, "iface")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "interface");
  }

  for (const m of getMatches("traits")) {
    const node = cap(m, "trait")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "trait");
  }

  // PHP 8+ extras — grammar coverage varies
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(PHP_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    const exM = (key: string) => exR[key]?.matches ?? [];
    for (const m of exM("enums")) {
      const node = cap(m, "enum")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "enum");
    }
    for (const m of exM("consts")) {
      const node = cap(m, "const")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (!node || !name) continue;
      const content = sourceLines
        .slice(node.startRow, node.endRow + 1)
        .join("\n");
      if (content.length < MIN_CONST_CHARS) continue;
      addChunk(node, name, "const");
    }
    for (const m of exM("properties")) {
      const node = cap(m, "prop")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (!node || !name) continue;
      let parentName: string | undefined;
      for (const chunk of chunks) {
        if (
          (chunk.type === "class" ||
            chunk.type === "interface" ||
            chunk.type === "trait") &&
          chunk.startLine <= node.startRow + 1 &&
          chunk.endLine >= node.endRow + 1
        ) {
          parentName = chunk.name;
          break;
        }
      }
      addChunk(node, name, "property", parentName);
    }
  } catch {
    /* PHP extras unsupported — skip */
  }

  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!methodNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "class" ||
          chunk.type === "interface" ||
          chunk.type === "trait" ||
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

  // --- EXTENDS / IMPLEMENTS edges ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const inh: any = packExtract(source, {
      language: "php",
      patterns: Object.fromEntries(
        Object.entries(PHP_INHERIT_QUERIES).map(([k, q]) => [
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
    for (const m of inhMatches("implements")) {
      const nameNode = cap(m, "name");
      const ifaceNode = cap(m, "iface");
      if (!nameNode?.node || !ifaceNode?.text) continue;
      const nameRow = nameNode.node.startRow;
      const classChunk = chunks.find(
        (c) => c.startLine === nameRow + 1 && c.type === "class",
      );
      rawEdges.push({
        sourceChunkId: classChunk?.id ?? "",
        sourceFilePath: filePath,
        type: "IMPLEMENTS",
        targetSymbol: ifaceNode.text,
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
