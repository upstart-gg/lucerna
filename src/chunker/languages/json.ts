import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk } from "../../types.js";
import { makeFileChunk, packProcess } from "./shared.js";

export function processJson(
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
