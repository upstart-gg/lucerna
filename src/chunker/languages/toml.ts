import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk } from "./shared.js";

export function extractToml(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const keyChunks = splitTomlByTables(sourceLines, filePath, projectId);
  if (keyChunks.length > 3) return { chunks: keyChunks, rawEdges: [] };
  return {
    chunks: [makeFileChunk(source, filePath, projectId, "toml")],
    rawEdges: [],
  };
}

/**
 * Splits a TOML file by [table] and [[array-of-tables]] headers.
 */
function splitTomlByTables(
  sourceLines: string[],
  filePath: string,
  projectId: string,
): CodeChunk[] {
  // Matches [table] or [[array]], capturing the key name
  const tablePattern = /^\[{1,2}([^\]]+)\]{1,2}/;
  const boundaries: { line: number; name: string }[] = [];

  for (let i = 0; i < sourceLines.length; i++) {
    const m = sourceLines[i]?.match(tablePattern);
    if (m?.[1]) boundaries.push({ line: i + 1, name: m[1].trim() });
  }

  if (boundaries.length === 0) return [];

  const chunks: CodeChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (!b) continue;
    const nextLine = boundaries[i + 1]?.line ?? sourceLines.length + 1;
    const content = sourceLines.slice(b.line - 1, nextLine - 1).join("\n");
    const breadcrumb = `# File: ${filePath}\n# Table: ${b.name}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "toml",
      type: "file",
      name: b.name,
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: b.line,
      endLine: nextLine - 1,
      metadata: { breadcrumb },
    });
  }
  return chunks;
}
