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
