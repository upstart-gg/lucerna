import { basename } from "node:path";
import * as languagePack from "@kreuzberg/tree-sitter-language-pack";
import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk, Language } from "../../types.js";

// extract() exists at runtime but is missing from the published type definitions.
// biome-ignore lint/suspicious/noExplicitAny: extract is not typed in the published types
export const packExtract = (languagePack as any).extract as (
  source: string,
  config: unknown,
) => unknown;

export const packProcess = languagePack.process;

// ---------------------------------------------------------------------------
// Shared types for tree-sitter extract() output
// ---------------------------------------------------------------------------

export type MatchCapture = {
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

export type PatternMatch = { captures: MatchCapture[] };

// ---------------------------------------------------------------------------
// Leading-comment / decorator / annotation / attribute absorption
// ---------------------------------------------------------------------------

export interface AbsorbConfig {
  /** Line prefixes to absorb (checked on trimmed line). */
  linePrefixes?: string[];
  /** Block comment open/close pairs. */
  blockComments?: { open: string; close: string }[];
  /** Regexes for decorator/annotation/attribute lines (applied to trimmed line). */
  linePatterns?: RegExp[];
  /** Max preceding lines to scan. Default 80 — avoids swallowing license headers. */
  maxLines?: number;
}

/**
 * Expand a chunk's start row upward to include contiguous leading doc-comments,
 * decorators, annotations, or attributes. Returns the new startRow (0-based) to
 * use for the chunk. A single blank line is tolerated between the absorbed span
 * and the node (typical docstring gap).
 */
export function absorbUpward(
  sourceLines: string[],
  nodeStartRow: number,
  cfg: AbsorbConfig,
): number {
  const maxLines = cfg.maxLines ?? 80;
  const prefixes = cfg.linePrefixes ?? [];
  const blocks = cfg.blockComments ?? [];
  const patterns = cfg.linePatterns ?? [];
  if (prefixes.length === 0 && blocks.length === 0 && patterns.length === 0) {
    return nodeStartRow;
  }

  const matchesLine = (trimmed: string): boolean => {
    if (trimmed === "") return false;
    for (const p of prefixes) {
      if (trimmed.startsWith(p)) return true;
    }
    for (const rx of patterns) {
      if (rx.test(trimmed)) return true;
    }
    for (const b of blocks) {
      if (trimmed.startsWith(b.open) && trimmed.endsWith(b.close)) return true;
    }
    return false;
  };

  let row = nodeStartRow - 1;
  let lowestAbsorbed = nodeStartRow;
  let blankTolerated = false;
  const stopRow = Math.max(0, nodeStartRow - maxLines);

  while (row >= stopRow) {
    const line = sourceLines[row] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      if (!blankTolerated && lowestAbsorbed < nodeStartRow) {
        blankTolerated = true;
        row--;
        continue;
      }
      break;
    }

    // Multi-line block-comment: if the line ends a block, walk up to the open.
    let absorbedBlock = false;
    for (const b of blocks) {
      if (trimmed.endsWith(b.close)) {
        let openRow = row;
        let found = false;
        while (openRow >= stopRow) {
          const l = (sourceLines[openRow] ?? "").trim();
          if (l.startsWith(b.open)) {
            found = true;
            break;
          }
          openRow--;
        }
        if (found) {
          lowestAbsorbed = openRow;
          row = openRow - 1;
          blankTolerated = false;
          absorbedBlock = true;
          break;
        }
      }
    }
    if (absorbedBlock) continue;

    if (matchesLine(trimmed)) {
      lowestAbsorbed = row;
      row--;
      blankTolerated = false;
      continue;
    }

    break;
  }

  return lowestAbsorbed;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function makeFileChunk(
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

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Unified chunk builder: computes expanded line range (via absorbUpward when an
 * AbsorbConfig is provided), extracts content, assembles breadcrumb/contextContent,
 * and returns a CodeChunk. Replaces per-language addChunk closures.
 */
export function buildChunkFromNode(args: {
  node: NonNullable<MatchCapture["node"]>;
  sourceLines: string[];
  projectId: string;
  filePath: string;
  language: string;
  type: ChunkType;
  name?: string;
  parentName?: string;
  importContent?: string;
  absorb?: AbsorbConfig;
  extraMetadata?: Record<string, unknown>;
}): CodeChunk {
  const {
    node,
    sourceLines,
    projectId,
    filePath,
    language,
    type,
    name,
    parentName,
    importContent,
    absorb,
    extraMetadata,
  } = args;

  const startRow = absorb
    ? absorbUpward(sourceLines, node.startRow, absorb)
    : node.startRow;
  const endRow = node.endRow;
  const content = sourceLines.slice(startRow, endRow + 1).join("\n");

  const breadcrumbParts: string[] = [];
  if (parentName) breadcrumbParts.push(`// Class: ${parentName}`);
  if (name) breadcrumbParts.push(`// ${capitalize(type)}: ${name}`);
  const breadcrumb = breadcrumbParts.join("\n");

  const contextParts: string[] = [];
  if (breadcrumb) contextParts.push(breadcrumb);
  if (importContent) contextParts.push(importContent);
  contextParts.push(content);

  const metadata: Record<string, unknown> = { ...(extraMetadata ?? {}) };
  if (parentName) metadata.className = parentName;
  if (breadcrumb) metadata.breadcrumb = breadcrumb;

  return {
    id: "",
    projectId,
    filePath,
    language,
    type,
    ...(name != null ? { name } : {}),
    content,
    contextContent: contextParts.join("\n\n"),
    startLine: startRow + 1,
    endLine: endRow + 1,
    metadata,
  };
}

/**
 * Extract the module name from a raw import statement string.
 * Used by `processWithPack()` to build IMPORTS edges for Python, Java, Rust, etc.
 */
export function extractImportModule(
  source: string,
  language?: string,
): string | null {
  const s = source.trim().replace(/;$/, "");
  let m: RegExpMatchArray | null;
  // Python: "from pathlib import Path" | "import os"
  m = s.match(/^from\s+(\S+)\s+import/);
  if (m?.[1]) return m[1];
  m = s.match(/^import\s+([\w.]+)$/);
  if (m?.[1]) return m[1];
  // Java: "import java.util.List" | "import static ..."
  m = s.match(/^import\s+(?:static\s+)?([\w.]+)/);
  if (m?.[1]) return m[1];
  // Rust: "use std::io"
  m = s.match(/^use\s+([\w:]+)/);
  if (m?.[1]) return m[1];
  // Suppress unused parameter warning — language reserved for future use
  void language;
  return null;
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
export function mergeSiblingChunks(
  chunks: CodeChunk[],
  minMergeChars: number,
): CodeChunk[] {
  if (chunks.length <= 1) return chunks;

  const NEVER_MERGE: Set<ChunkType> = new Set([
    "import",
    "class",
    "struct",
    "record",
    "enum",
    "namespace",
    "module",
    "library",
    "interface",
    "trait",
    "protocol",
    "file",
  ]);

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

export function mapKind(kind: string): ChunkType {
  switch (kind.toLowerCase()) {
    case "function":
    case "function_declaration":
    case "arrow_function":
    case "generator":
    case "generator_function_declaration":
      return "function";
    case "class":
    case "class_declaration":
    case "impl":
      return "class";
    case "struct":
    case "struct_declaration":
    case "struct_specifier":
    case "struct_item":
      return "struct";
    case "record":
    case "record_declaration":
      return "record";
    case "module":
    case "module_declaration":
    case "module_definition":
    case "mod_item":
      return "module";
    case "namespace":
    case "namespace_definition":
    case "internal_module":
      return "namespace";
    case "method":
    case "method_definition":
      return "method";
    case "interface":
    case "interface_declaration":
      return "interface";
    case "trait":
    case "trait_item":
    case "trait_definition":
      return "trait";
    case "protocol":
    case "protocol_declaration":
      return "protocol";
    case "mixin":
    case "mixin_declaration":
      return "mixin";
    case "extension":
    case "extension_declaration":
    case "category_interface":
      return "extension";
    case "object":
    case "object_declaration":
    case "object_definition":
      return "object";
    case "actor":
    case "actor_declaration":
      return "actor";
    case "enum":
    case "enum_declaration":
    case "enum_definition":
    case "enum_specifier":
    case "enum_item":
    case "enum_class_declaration":
      return "enum";
    case "type":
    case "type_declaration":
    case "type_definition":
      return "type";
    case "type_alias":
    case "typealias":
    case "type_alias_declaration":
    case "type_alias_statement":
    case "type_item":
    case "alias_declaration":
      return "typealias";
    case "newtype":
      return "newtype";
    case "instance":
    case "instance_declaration":
      return "instance";
    case "functor":
      return "functor";
    case "module_type":
    case "module_type_definition":
      return "module_type";
    case "macro":
    case "macro_definition":
    case "defmacro":
    case "preproc_def":
      return "macro";
    case "const":
    case "const_item":
    case "const_declaration":
    case "static_item":
      return "const";
    case "variable":
    case "variable_declaration":
    case "let":
      return "variable";
    case "property":
    case "property_declaration":
      return "property";
    case "test":
    case "test_declaration":
      return "test";
    case "param_block":
      return "param_block";
    case "dsl_call":
      return "dsl_call";
    case "state_variable":
    case "state_variable_declaration":
      return "state_variable";
    case "event":
    case "event_definition":
    case "event_declaration":
      return "event";
    case "modifier":
    case "modifier_definition":
      return "modifier";
    case "error":
    case "error_declaration":
      return "error";
    case "library":
    case "library_declaration":
      return "library";
    case "import":
    case "import_statement":
      return "import";
    default:
      return "file";
  }
}

// ---------------------------------------------------------------------------
// Generic pack-based fallback (used by languages without a custom extractor)
// ---------------------------------------------------------------------------

export function processWithPack(
  source: string,
  filePath: string,
  projectId: string,
  language: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape differs from types
  let result: any;
  try {
    result = packProcess(source, { language, structure: true, imports: true });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, language)],
      rawEdges: [],
    };
  }

  const sourceLines = source.split("\n");
  const chunks: CodeChunk[] = [];
  const rawEdges: RawEdge[] = [];

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
      ? `// ${capitalize(item.kind)}: ${item.name}`
      : "";
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: mapKind(item.kind),
      ...(item.name ? { name: item.name } : {}),
      content,
      contextContent: itemBreadcrumb
        ? `${itemBreadcrumb}\n\n${content}`
        : content,
      startLine,
      endLine,
      metadata: itemBreadcrumb ? { breadcrumb: itemBreadcrumb } : {},
    });

    // Also add child items (e.g. methods inside classes)
    for (const child of item.children ?? []) {
      const cStart = (child.span.startLine ?? 0) + 1;
      const cEnd = (child.span.endLine ?? 0) + 1;
      const cContent = sourceLines.slice(cStart - 1, cEnd).join("\n");
      const childBreadcrumbParts: string[] = [];
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
        contextContent: childBreadcrumb
          ? `${childBreadcrumb}\n\n${cContent}`
          : cContent,
        startLine: cStart,
        endLine: cEnd,
        metadata: {
          ...(item.name ? { className: item.name } : {}),
          ...(childBreadcrumb ? { breadcrumb: childBreadcrumb } : {}),
        },
      });
    }
  }

  if (chunks.length === 0) {
    chunks.push(makeFileChunk(source, filePath, projectId, language));
  }

  // Add import chunk if the language pack returned imports
  const importInfos: Array<{
    source: string;
    span: { startLine: number; endLine: number };
  }> = result.imports ?? [];
  if (importInfos.length > 0) {
    const startLine = Math.min(...importInfos.map((i) => i.span.startLine)) + 1;
    const endLine = Math.max(...importInfos.map((i) => i.span.endLine)) + 1;
    const content = sourceLines.slice(startLine - 1, endLine).join("\n");
    chunks.unshift({
      id: "",
      projectId,
      filePath,
      language,
      type: "import",
      content,
      contextContent: content,
      startLine,
      endLine,
      metadata: {},
    });
    for (const imp of importInfos) {
      const mod = extractImportModule(imp.source, language);
      if (mod) {
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
  }

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges };
}

// ---------------------------------------------------------------------------
// Language type alias for use in language modules
// ---------------------------------------------------------------------------

export type { Language, CodeChunk, ChunkType };
export type { RawEdge };
