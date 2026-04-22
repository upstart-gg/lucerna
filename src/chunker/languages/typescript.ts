import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk } from "../../types.js";
import { getAbsorb } from "./absorbPresets.js";
import {
  absorbUpward,
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Tree-sitter queries shared by TypeScript and JavaScript
// ---------------------------------------------------------------------------

const QUERIES = {
  imports: `(import_statement source: (string (string_fragment) @module)) @imp`,
  functions: `(function_declaration name: (identifier) @name) @fn`,
  generators: `(generator_function_declaration name: (identifier) @name) @fn`,
  arrowVars: `(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)] @fn)`,
  classes: `(class_declaration name: (type_identifier) @name) @cls`,
  methods: `(method_definition name: (property_identifier) @name) @method`,
  interfaces: `(interface_declaration name: (type_identifier) @name) @iface`,
  typeAliases: `(type_alias_declaration name: (type_identifier) @name) @type`,
  enums: `(enum_declaration name: (identifier) @name) @enum`,
  namespaces: `(internal_module name: (identifier) @name) @ns`,
  constVars: `(variable_declarator name: (identifier) @name value: [(object) (array) (call_expression) (template_string) (new_expression) (as_expression) (satisfies_expression)] @v) @const`,
  classExtends: `(class_declaration name: (type_identifier) @className (class_heritage (extends_clause value: (identifier) @baseClass))) @cls`,
  callExpressions: `(call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @call`,
  newExpressions: `(new_expression constructor: (identifier) @callee) @call`,
};

// JavaScript doesn't have type_identifier for class names — use identifier.
// JS class_heritage also uses a different node structure than TypeScript.
const JS_QUERIES = {
  ...QUERIES,
  classes: `(class_declaration name: (identifier) @name) @cls`,
  // JS: class_heritage has a direct identifier child, no extends_clause wrapper
  classExtends: `(class_declaration name: (identifier) @className (class_heritage (identifier) @baseClass)) @cls`,
  interfaces: null, // JS has no interfaces
  typeAliases: null, // JS has no type aliases
  enums: null, // JS has no enums
  namespaces: null, // JS has no namespace syntax
  constVars: `(variable_declarator name: (identifier) @name value: [(object) (array) (call_expression) (template_string) (new_expression)] @v) @const`,
};

// ---------------------------------------------------------------------------
// TypeScript / JavaScript — query-based extraction via extract()
// ---------------------------------------------------------------------------

export function extractTsJs(
  source: string,
  filePath: string,
  projectId: string,
  language: "typescript" | "javascript",
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const isTs = language === "typescript";
  const queryMap = isTs ? QUERIES : JS_QUERIES;

  // Build the patterns config (skip null entries)
  const patterns: Record<string, { query: string; captureOutput: string }> = {};
  for (const [key, query] of Object.entries(queryMap)) {
    if (query) patterns[key] = { query, captureOutput: "Full" };
  }

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, { language, patterns });
  } catch {
    // If extraction fails (e.g. unsupported query), fall back to process()
    return processWithPack(source, filePath, projectId, language);
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;

  const getMatches = (key: string): PatternMatch[] =>
    results[key]?.matches ?? [];

  const chunks: CodeChunk[] = [];
  const rawEdges: RawEdge[] = [];

  // Helper: find capture by name within a match
  const cap = (match: PatternMatch, name: string): MatchCapture | undefined =>
    match.captures.find((c) => c.name === name);

  // --- Import chunk ---
  let importsText = "";
  const importMatches = getMatches("imports");
  const importModules: string[] = [];

  if (importMatches.length > 0) {
    // Collect import statement nodes (capture name "imp")
    const impNodes = importMatches
      .map((m) => cap(m, "imp")?.node)
      .filter((n): n is NonNullable<typeof n> => n != null);

    const startRow = Math.min(...impNodes.map((n) => n.startRow));
    const endRow = Math.max(...impNodes.map((n) => n.endRow));
    importsText = sourceLines.slice(startRow, endRow + 1).join("\n");

    for (const m of importMatches) {
      const modText = cap(m, "module")?.text ?? "";
      if (modText) importModules.push(modText);
    }

    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "import",
      content: importsText,
      contextContent: importsText,
      startLine: startRow + 1,
      endLine: endRow + 1,
      metadata: {},
    });

    for (const mod of importModules) {
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

  // Build import alias map: symbol → module (for EXTENDS targetFilePath)
  const importAliasMap = new Map<string, string>();
  for (const m of importMatches) {
    const modText = cap(m, "module")?.text ?? "";
    // Also capture named imports from the imp text (not directly available;
    // use the source line to find named imports)
    const impText = cap(m, "imp")?.text ?? "";
    const namedMatch = impText.match(/\{([^}]+)\}/);
    if (namedMatch?.[1]) {
      for (const name of namedMatch[1].split(",")) {
        const trimmed = name
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (trimmed) importAliasMap.set(trimmed, modText);
      }
    }
    // Default import: `import Foo from 'bar'`
    const defaultMatch = impText.match(/^import\s+(\w+)\s+from/);
    if (defaultMatch?.[1]) importAliasMap.set(defaultMatch[1], modText);
  }

  // Build a class→startRow map for method contextContent
  const classHeaders = new Map<string, string>(); // className → first line of class decl
  for (const m of getMatches("classes")) {
    const nameText = cap(m, "name")?.text ?? "";
    const clsNode = cap(m, "cls")?.node;
    if (nameText && clsNode) {
      classHeaders.set(nameText, sourceLines[clsNode.startRow] ?? "");
    }
  }

  // --- Structure chunks ---

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
    const endRow = node.endRow;
    const content = sourceLines.slice(startRow, endRow + 1).join("\n");

    const breadcrumbParts: string[] = [];
    if (parentName) breadcrumbParts.push(`// Class: ${parentName}`);
    breadcrumbParts.push(
      `// ${type.charAt(0).toUpperCase()}${type.slice(1)}: ${name}`,
    );
    const breadcrumb = breadcrumbParts.join("\n");

    const parts: string[] = [breadcrumb];
    if (importsText) parts.push(importsText);
    if (parentName) {
      const header = classHeaders.get(parentName);
      if (header) parts.push(header);
    }
    parts.push(content);
    const contextContent = parts.join("\n\n");

    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type,
      name,
      content,
      contextContent,
      startLine: startRow + 1,
      endLine: endRow + 1,
      metadata: parentName
        ? { className: parentName, breadcrumb }
        : { breadcrumb },
    });
  };

  // Functions
  for (const m of getMatches("functions")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (fnNode && name) addChunk(fnNode, name, "function");
  }

  // Generator functions
  for (const m of getMatches("generators")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (fnNode && name) addChunk(fnNode, name, "function");
  }

  // Arrow functions / function expressions assigned to variables
  for (const m of getMatches("arrowVars")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (fnNode && name) addChunk(fnNode, name, "function");
  }

  // Classes
  for (const m of getMatches("classes")) {
    const clsNode = cap(m, "cls")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (clsNode && name) addChunk(clsNode, name, "class");
  }

  // Methods (nested inside classes)
  for (const m of getMatches("methods")) {
    const methodNode = cap(m, "method")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!methodNode || !name) continue;
    // Find which class this method belongs to by checking which class span contains it
    let parentName: string | undefined;
    for (const cm of getMatches("classes")) {
      const clsNode = cap(cm, "cls")?.node;
      const className = cap(cm, "name")?.text ?? "";
      if (
        clsNode &&
        methodNode.startRow >= clsNode.startRow &&
        methodNode.endRow <= clsNode.endRow
      ) {
        parentName = className;
        break;
      }
    }
    addChunk(methodNode, name, "method", parentName);
  }

  // Interfaces (TypeScript only)
  for (const m of getMatches("interfaces")) {
    const ifaceNode = cap(m, "iface")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (ifaceNode && name) addChunk(ifaceNode, name, "interface");
  }

  // Type aliases (TypeScript only)
  for (const m of getMatches("typeAliases")) {
    const typeNode = cap(m, "type")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (typeNode && name) addChunk(typeNode, name, "type");
  }

  // Enums (TypeScript only)
  for (const m of getMatches("enums")) {
    const enumNode = cap(m, "enum")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (enumNode && name) addChunk(enumNode, name, "enum");
  }

  // Namespaces (TypeScript only)
  for (const m of getMatches("namespaces")) {
    const nsNode = cap(m, "ns")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (nsNode && name) addChunk(nsNode, name, "namespace");
  }

  // Top-level const declarations (objects, arrays, call_expressions, etc. —
  // NOT arrow/function expressions which are handled by arrowVars).
  // Scoped to program-level via lexical_declaration or export_statement parents.
  const MIN_CONST_CHARS = 40;
  for (const m of getMatches("constVars")) {
    const constNode = cap(m, "const")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!constNode || !name) continue;
    // Only top-level: the declarator must be 2-3 levels shallow. Heuristic:
    // reject if any already-captured function/method/class chunk strictly
    // contains it (nested const inside a function body).
    const isNested = chunks.some(
      (c) =>
        (c.type === "function" || c.type === "method" || c.type === "class") &&
        c.startLine - 1 < constNode.startRow &&
        c.endLine - 1 > constNode.endRow,
    );
    if (isNested) continue;
    const content = sourceLines
      .slice(constNode.startRow, constNode.endRow + 1)
      .join("\n");
    if (content.length < MIN_CONST_CHARS) continue;
    addChunk(constNode, name, "const");
  }

  // Fallback: if nothing was extracted, produce a whole-file chunk
  if (chunks.length === 0) {
    const lines = source.split("\n");
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "file",
      name: filePath.split("/").pop() ?? filePath,
      content: source,
      contextContent: source,
      startLine: 1,
      endLine: lines.length,
      metadata: {},
    });
  }

  // --- Graph edges ---

  // EXTENDS edges
  for (const m of getMatches("classExtends")) {
    const className = cap(m, "className")?.text ?? "";
    const baseClass = cap(m, "baseClass")?.text ?? "";
    if (!baseClass) continue;
    // Find the class chunk to use as sourceChunkId (resolved after ID assignment)
    const clsNode = cap(m, "cls")?.node;
    const classChunk = chunks.find(
      (c) =>
        c.type === "class" &&
        c.name === className &&
        clsNode &&
        c.startLine === clsNode.startRow + 1,
    );
    rawEdges.push({
      sourceChunkId: classChunk?.id ?? "", // will be filled after ID assignment
      sourceFilePath: filePath,
      type: "EXTENDS",
      targetSymbol: baseClass,
      ...(importAliasMap.has(baseClass)
        ? { targetFilePath: importAliasMap.get(baseClass) as string }
        : {}),
      metadata: {},
    });
  }

  // CALLS edges (function calls within function/method bodies)
  for (const m of getMatches("callExpressions")) {
    const callee = cap(m, "callee")?.text ?? "";
    const callNode = cap(m, "call")?.node;
    if (!callee || !callNode) continue;
    // Find the enclosing function/method chunk
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
  for (const m of getMatches("newExpressions")) {
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
