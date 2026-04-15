import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import * as languagePack from "@kreuzberg/tree-sitter-language-pack";
import type { ChunkingWithEdgesResult, RawEdge } from "../graph/types.js";
import type { ChunkType, CodeChunk, Language } from "../types.js";
import { extractMarkdown } from "./languages/markdown.js";

// extract() exists at runtime but is missing from the published type definitions.
// Use the namespace import and cast rather than require().
// biome-ignore lint/suspicious/noExplicitAny: extract is not typed in the published types
const packExtract = (languagePack as any).extract as (
  source: string,
  config: unknown,
) => unknown;

const packDetectLanguage = languagePack.detectLanguage;
const packInit = languagePack.init;
const packProcess = languagePack.process;

// Languages pre-initialized with the language pack (all tree-sitter grammars)
const DEFAULT_LANGUAGES = ["typescript", "javascript", "json"];

// Aliases: some pack language names need mapping to our canonical names
const LANGUAGE_ALIASES: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
};

export interface ChunkerOptions {
  maxChunkTokens?: number;
  /** Minimum chunk size in tokens. Adjacent siblings that are both below this
   * threshold are merged into one chunk to avoid low-quality micro-embeddings
   * (e.g. a class with 10 trivial one-liner getters). Defaults to 0 (disabled).
   * A value of 50 (≈ 200 chars) is a reasonable starting point. */
  minChunkTokens?: number;
}

/**
 * AST-based file chunker. Uses @kreuzberg/tree-sitter-language-pack to parse
 * source files and extract semantically meaningful chunks (functions, classes,
 * sections, etc.). Supports 305 languages via the underlying Rust native addon.
 *
 * Markdown is handled via a regex-based extractor (no grammar needed).
 * TypeScript/JavaScript use extract() with tree-sitter queries for full fidelity.
 * Other languages fall back to process() structure extraction.
 */
export class TreeSitterChunker {
  private maxChunkTokens: number;
  private minMergeChars: number;
  /** Languages that have been passed to packInit and are ready to use. */
  private initializedLanguages: Set<string> = new Set();
  private initialized = false;

  constructor(options: ChunkerOptions = {}) {
    this.maxChunkTokens = options.maxChunkTokens ?? 1500;
    // chars ≈ tokens * 4; 0 means merging is disabled (default)
    this.minMergeChars = (options.minChunkTokens ?? 0) * 4;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Pre-warm the default languages; all others are initialized lazily on first encounter.
    packInit({ languages: DEFAULT_LANGUAGES });
    for (const lang of DEFAULT_LANGUAGES) this.initializedLanguages.add(lang);
    // markdown is handled inline (no grammar needed)
    this.initializedLanguages.add("markdown");
    this.initialized = true;
  }

  static detectLanguage(filePath: string): Language | null {
    const raw = packDetectLanguage(filePath);
    if (!raw) return null;
    return LANGUAGE_ALIASES[raw] ?? raw;
  }

  async chunkFile(
    filePath: string,
    projectId: string,
    language?: Language,
  ): Promise<CodeChunk[]> {
    const lang = language ?? TreeSitterChunker.detectLanguage(filePath);
    if (!lang) return [];
    const source = await readFile(filePath, "utf8");
    return this.chunkSource(source, filePath, projectId, lang);
  }

  async chunkSource(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<CodeChunk[]> {
    const { chunks } = await this.chunkSourceInternal(
      source,
      filePath,
      projectId,
      language,
    );
    return chunks;
  }

  /**
   * Chunk a file and also extract raw knowledge-graph edges.
   */
  async chunkFileWithEdges(
    filePath: string,
    projectId: string,
    language?: Language,
  ): Promise<ChunkingWithEdgesResult> {
    const lang = language ?? TreeSitterChunker.detectLanguage(filePath);
    if (!lang) return { chunks: [], rawEdges: [] };
    const source = await readFile(filePath, "utf8");
    return this.chunkSourceWithEdges(source, filePath, projectId, lang);
  }

  /**
   * Chunk source text and also extract raw knowledge-graph edges.
   */
  async chunkSourceWithEdges(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<ChunkingWithEdgesResult> {
    return this.chunkSourceInternal(source, filePath, projectId, language);
  }

  // kept for API compatibility — no cleanup needed with the native addon
  async close(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Core implementation — always returns both chunks and edges
  // ---------------------------------------------------------------------------

  private async chunkSourceInternal(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<ChunkingWithEdgesResult> {
    if (!this.initialized) {
      throw new Error("TreeSitterChunker.initialize() must be called first");
    }

    // Markdown is handled inline — no grammar initialization needed.
    // For all other languages, lazily initialize via packInit on first encounter.
    if (language !== "markdown" && !this.initializedLanguages.has(language)) {
      if (!languagePack.hasLanguage(language)) {
        return { chunks: [], rawEdges: [] };
      }
      // packInit is synchronous; safe to call from concurrent Promise.all paths
      // because the check+init+add block has no await — JS won't context-switch.
      packInit({ languages: [language] });
      this.initializedLanguages.add(language);
    }

    let chunks: CodeChunk[];
    let rawEdges: RawEdge[];

    if (language === "markdown") {
      chunks = extractMarkdown(
        source,
        filePath,
        projectId,
        this.maxChunkTokens * 4,
      );
      rawEdges = [];
    } else if (language === "json") {
      ({ chunks, rawEdges } = processJson(
        source,
        filePath,
        projectId,
        this.maxChunkTokens,
      ));
    } else if (language === "typescript" || language === "javascript") {
      ({ chunks, rawEdges } = extractTsJs(
        source,
        filePath,
        projectId,
        language,
        this.minMergeChars,
      ));
    } else {
      ({ chunks, rawEdges } = processWithPack(
        source,
        filePath,
        projectId,
        language,
        this.minMergeChars,
      ));
    }

    for (const chunk of chunks) {
      if (!chunk.id) {
        chunk.id = hashChunkId(
          chunk.projectId,
          chunk.filePath,
          chunk.startLine,
        );
      }
    }

    // Fill in sourceChunkId for edges that haven't had it set yet
    // (uses the first chunk as fallback — import chunk if present)
    const firstId = chunks[0]?.id;
    if (firstId) {
      for (const edge of rawEdges) {
        if (!edge.sourceChunkId) edge.sourceChunkId = firstId;
      }
    }

    // DEFINES edges: import chunk → each named chunk (TS/JS only)
    if (language === "typescript" || language === "javascript") {
      const importChunk = chunks.find((c) => c.type === "import");
      if (importChunk?.id) {
        for (const chunk of chunks) {
          if (chunk.type !== "import" && chunk.name && chunk.id) {
            rawEdges.push({
              sourceChunkId: importChunk.id,
              sourceFilePath: filePath,
              type: "DEFINES",
              targetSymbol: chunk.id,
              metadata: {},
            });
          }
        }
      }
    }

    return { chunks, rawEdges };
  }
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript — query-based extraction via extract()
// ---------------------------------------------------------------------------

// Tree-sitter queries shared by TypeScript and JavaScript
const QUERIES = {
  imports: `(import_statement source: (string (string_fragment) @module)) @imp`,
  functions: `(function_declaration name: (identifier) @name) @fn`,
  generators: `(generator_function_declaration name: (identifier) @name) @fn`,
  arrowVars: `(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)] @fn)`,
  classes: `(class_declaration name: (type_identifier) @name) @cls`,
  methods: `(method_definition name: (property_identifier) @name) @method`,
  interfaces: `(interface_declaration name: (type_identifier) @name) @iface`,
  typeAliases: `(type_alias_declaration name: (type_identifier) @name) @type`,
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
};

type MatchCapture = {
  name: string;
  text: string | null;
  node: {
    startRow: number;
    endRow: number;
    startByte: number;
    endByte: number;
  } | null;
  startByte: number;
};

type PatternMatch = { captures: MatchCapture[] };

function extractTsJs(
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

  // Helper: get text slice for a node's row span
  const nodeContent = (node: MatchCapture["node"]): string => {
    if (!node) return "";
    return sourceLines.slice(node.startRow, node.endRow + 1).join("\n");
  };

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

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: ChunkType,
    parentName?: string,
  ) => {
    const content = nodeContent(node);

    // Scope breadcrumb: file → class (if any) → symbol type + name.
    // Prepended to contextContent so the embedding carries structural context
    // (e.g. a method named `validate` knows it lives in `UserAuthService`).
    const breadcrumbParts = [`// File: ${filePath}`];
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
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
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

  // Fallback: if nothing was extracted, produce a whole-file chunk
  if (chunks.length === 0) {
    chunks.push(makeFileChunk(source, filePath, projectId, language));
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

// ---------------------------------------------------------------------------
// TypeScript / JavaScript (and any other language) — structure-based chunking
// (fallback for non-TS/JS languages using process())
// ---------------------------------------------------------------------------

function processWithPack(
  source: string,
  filePath: string,
  projectId: string,
  language: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape differs from types
  let result: any;
  try {
    result = packProcess(source, { language, structure: true });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, language)],
      rawEdges: [],
    };
  }

  const sourceLines = source.split("\n");
  const chunks: CodeChunk[] = [];

  const structure: Array<{
    kind: string;
    name?: string;
    span: { startLine: number; endLine: number };
    children?: Array<{
      kind: string;
      name?: string;
      span: { startLine: number; endLine: number };
    }>;
  }> = result.structure ?? [];

  for (const item of structure) {
    const startLine = (item.span.startLine ?? 0) + 1;
    const endLine = (item.span.endLine ?? 0) + 1;
    const content = sourceLines.slice(startLine - 1, endLine).join("\n");

    const itemBreadcrumb = item.name
      ? `// File: ${filePath}\n// ${capitalize(item.kind)}: ${item.name}`
      : `// File: ${filePath}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: mapKind(item.kind),
      ...(item.name ? { name: item.name } : {}),
      content,
      contextContent: `${itemBreadcrumb}\n\n${content}`,
      startLine,
      endLine,
      metadata: { breadcrumb: itemBreadcrumb },
    });

    // Also add child items (e.g. methods inside classes)
    for (const child of item.children ?? []) {
      const cStart = (child.span.startLine ?? 0) + 1;
      const cEnd = (child.span.endLine ?? 0) + 1;
      const cContent = sourceLines.slice(cStart - 1, cEnd).join("\n");
      const childBreadcrumbParts = [`// File: ${filePath}`];
      if (item.name) childBreadcrumbParts.push(`// Class: ${item.name}`);
      if (child.name)
        childBreadcrumbParts.push(
          `// ${capitalize(child.kind)}: ${child.name}`,
        );
      const childBreadcrumb = childBreadcrumbParts.join("\n");
      chunks.push({
        id: "",
        projectId,
        filePath,
        language,
        type: mapKind(child.kind),
        ...(child.name ? { name: child.name } : {}),
        content: cContent,
        contextContent: `${childBreadcrumb}\n\n${cContent}`,
        startLine: cStart,
        endLine: cEnd,
        metadata: {
          ...(item.name ? { className: item.name } : {}),
          breadcrumb: childBreadcrumb,
        },
      });
    }
  }

  if (chunks.length === 0) {
    chunks.push(makeFileChunk(source, filePath, projectId, language));
  }

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges: [] };
}

// ---------------------------------------------------------------------------
// JSON — structure-based or key-based chunking
// ---------------------------------------------------------------------------

function processJson(
  source: string,
  filePath: string,
  projectId: string,
  maxChunkTokens: number,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const maxChunkChars = maxChunkTokens * 4;
  const sourceLines = source.split("\n");

  // Split by top-level keys when there are enough to warrant separate chunks.
  // Threshold: more than 3 keys, which distinguishes small config files (2-3 keys)
  // from larger data/schema files (many keys) that benefit from per-key chunking.
  const keyChunks = splitJsonByTopLevelKeys(sourceLines, filePath, projectId);
  if (keyChunks.length > 3) return { chunks: keyChunks, rawEdges: [] };

  // Few keys or no keys: keep as single chunk if within size limit
  if (source.length <= maxChunkChars) {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, "json")],
      rawEdges: [],
    };
  }

  // Large file with few or no top-level keys: try pack structure
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape differs from types
  let result: any;
  try {
    result = packProcess(source, { language: "json", structure: true });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, "json")],
      rawEdges: [],
    };
  }

  if (result.structure?.length > 0) {
    const chunks = result.structure.map(
      (item: {
        name?: string;
        span: { startLine: number; endLine: number };
      }) => {
        const startLine = (item.span.startLine ?? 0) + 1;
        const endLine = (item.span.endLine ?? 0) + 1;
        const content = sourceLines.slice(startLine - 1, endLine).join("\n");
        return {
          id: "",
          projectId,
          filePath,
          language: "json",
          type: "file" as ChunkType,
          name: item.name,
          content,
          contextContent: content,
          startLine,
          endLine,
          metadata: {},
        };
      },
    );
    return { chunks, rawEdges: [] };
  }

  // Last resort: single file chunk
  return {
    chunks: [makeFileChunk(source, filePath, projectId, "json")],
    rawEdges: [],
  };
}

/**
 * Splits a pretty-printed JSON object by its top-level keys using line scanning.
 * Expects 2-space-indented JSON (the output of JSON.stringify(obj, null, 2)).
 */
function splitJsonByTopLevelKeys(
  sourceLines: string[],
  filePath: string,
  projectId: string,
): CodeChunk[] {
  // Top-level keys appear as lines with exactly 2-space indent: `  "key":`
  const keyPattern = /^ {2}"([^"]+)"\s*:/;
  const boundaries: { line: number; name: string }[] = [];

  for (let i = 0; i < sourceLines.length; i++) {
    const m = sourceLines[i]?.match(keyPattern);
    if (m?.[1]) boundaries.push({ line: i + 1, name: m[1] });
  }

  if (boundaries.length === 0) return [];

  const chunks: CodeChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (!b) continue;
    const nextLine = boundaries[i + 1]?.line ?? sourceLines.length + 1;
    const content = sourceLines.slice(b.line - 1, nextLine - 1).join("\n");
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "json",
      type: "file",
      name: b.name,
      content,
      contextContent: content,
      startLine: b.line,
      endLine: nextLine - 1,
      metadata: {},
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeFileChunk(
  source: string,
  filePath: string,
  projectId: string,
  language: string,
): CodeChunk {
  const lines = source.split("\n");
  return {
    id: "",
    projectId,
    filePath,
    language,
    type: "file",
    name: basename(filePath),
    content: source,
    contextContent: source,
    startLine: 1,
    endLine: lines.length,
    metadata: {},
  };
}

function mapKind(kind: string): ChunkType {
  switch (kind.toLowerCase()) {
    case "function":
    case "function_declaration":
    case "arrow_function":
    case "generator":
    case "generator_function_declaration":
      return "function";
    case "class":
    case "class_declaration":
    // Rust/C++ struct, Rust impl block — "class" is the nearest ChunkType
    case "struct":
    case "impl":
    // Ruby/Python/JS module
    case "module":
      return "class";
    case "method":
    case "method_definition":
      return "method";
    case "interface":
    case "interface_declaration":
    // Rust trait, Swift protocol
    case "trait":
    case "protocol":
      return "interface";
    case "type":
    case "type_alias":
    case "type_declaration":
    // Rust/Java/Kotlin enum
    case "enum":
      return "type";
    case "variable":
    case "variable_declaration":
    case "const":
    case "let":
      return "variable";
    case "import":
    case "import_statement":
      return "import";
    default:
      return "file";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Merge adjacent sibling chunks that are both below `minMergeChars` in length.
 *
 * Rationale: AST extraction often emits many tiny chunks (e.g. one-line type
 * aliases, tiny getters). Short chunks produce low-quality embeddings and bloat
 * the index. Merging adjacent siblings that share the same parent class scope
 * reduces index size and improves embedding quality.
 *
 * Rules:
 * - Never merge `import` or `class` chunks (used as context anchors elsewhere).
 * - Only merge when *both* the current and next chunk are below the threshold.
 * - Only merge within the same class scope (`metadata.className` must match).
 * - Adjacency: next chunk starts within 2 lines of the previous chunk's end.
 */
function mergeSiblingChunks(
  chunks: CodeChunk[],
  minMergeChars: number,
): CodeChunk[] {
  if (chunks.length <= 1) return chunks;

  const NEVER_MERGE: Set<ChunkType> = new Set(["import", "class"]);

  const result: CodeChunk[] = [];
  let i = 0;

  while (i < chunks.length) {
    const current = chunks[i];
    if (!current) {
      i++;
      continue;
    }

    // Anchors and large chunks are never the start of a merge run
    if (
      NEVER_MERGE.has(current.type) ||
      current.content.length >= minMergeChars
    ) {
      result.push(current);
      i++;
      continue;
    }

    // Accumulate a run of mergeable siblings
    const run: CodeChunk[] = [current];
    while (i + 1 < chunks.length) {
      const prev = run[run.length - 1];
      const next = chunks[i + 1];
      if (!prev || !next) break;
      // Stop at anchors or large next chunks
      if (NEVER_MERGE.has(next.type) || next.content.length >= minMergeChars)
        break;
      // Must be adjacent (allow one blank line between them)
      if (next.startLine > prev.endLine + 2) break;
      // Must share the same class scope
      if (
        (prev.metadata.className ?? null) !== (next.metadata.className ?? null)
      )
        break;
      run.push(next);
      i++;
    }

    if (run.length === 1) {
      result.push(current);
    } else {
      // Combine into one merged chunk
      const first = run[0] as CodeChunk;
      const last = run[run.length - 1] as CodeChunk;
      const mergedContent = run.map((c) => c.content).join("\n");
      const firstName = first.name;
      const mergedName =
        firstName != null ? `${firstName} +${run.length - 1}` : undefined;

      // Rebuild contextContent: reuse the breadcrumb and imports prefix from
      // the first chunk's contextContent, then append the merged content.
      // The breadcrumb is stored in metadata; reconstruct parts manually.
      const breadcrumb = first.metadata.breadcrumb as string | undefined;
      const contextParts: string[] = [];
      if (breadcrumb) contextParts.push(breadcrumb);
      // Re-extract any imports/class-header prefix that preceded the first
      // chunk's own content in its contextContent.
      if (breadcrumb) {
        const afterBreadcrumb = first.contextContent
          .slice(breadcrumb.length)
          .trimStart();
        const contentIdx = afterBreadcrumb.lastIndexOf(first.content);
        if (contentIdx > 0) {
          contextParts.push(afterBreadcrumb.slice(0, contentIdx).trimEnd());
        }
      } else {
        // No breadcrumb: strip trailing occurrence of first.content to get prefix
        const contentIdx = first.contextContent.lastIndexOf(first.content);
        if (contentIdx > 0) {
          contextParts.push(
            first.contextContent.slice(0, contentIdx).trimEnd(),
          );
        }
      }
      contextParts.push(mergedContent);

      result.push({
        id: "", // re-assigned by the caller's hashChunkId loop
        projectId: first.projectId,
        filePath: first.filePath,
        language: first.language,
        type: first.type,
        ...(mergedName != null ? { name: mergedName } : {}),
        content: mergedContent,
        contextContent: contextParts.join("\n\n"),
        startLine: first.startLine,
        endLine: last.endLine,
        metadata: { ...first.metadata },
      });
    }

    i++;
  }

  return result;
}

export function hashChunkId(
  projectId: string,
  filePath: string,
  startLine: number,
): string {
  return createHash("sha1")
    .update(`${projectId}:${filePath}:${startLine}`)
    .digest("hex")
    .slice(0, 16);
}
