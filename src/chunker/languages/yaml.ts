import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import { makeFileChunk } from "./shared.js";

export function extractYaml(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const keyChunks = splitYamlByTopLevelKeys(sourceLines, filePath, projectId);
  if (keyChunks.length > 3) return { chunks: keyChunks, rawEdges: [] };
  return {
    chunks: [makeFileChunk(source, filePath, projectId, "yaml")],
    rawEdges: [],
  };
}

/**
 * Splits a YAML file by top-level keys (col-0 `key:` lines) and `---` document separators.
 */
function splitYamlByTopLevelKeys(
  sourceLines: string[],
  filePath: string,
  projectId: string,
): CodeChunk[] {
  // Top-level key: starts at column 0 with an identifier followed by ":"
  const keyPattern = /^([a-zA-Z_][a-zA-Z0-9_-]*):/;
  const docSeparator = /^---/;
  const boundaries: { line: number; name: string }[] = [];

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i] ?? "";
    const keyMatch = line.match(keyPattern);
    if (keyMatch?.[1]) {
      boundaries.push({ line: i + 1, name: keyMatch[1] });
    } else if (docSeparator.test(line) && boundaries.length > 0) {
      // New document section — use the separator line as a boundary
      boundaries.push({ line: i + 1, name: "---" });
    }
  }

  if (boundaries.length === 0) return [];

  const chunks: CodeChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (!b) continue;
    const nextLine = boundaries[i + 1]?.line ?? sourceLines.length + 1;
    const content = sourceLines.slice(b.line - 1, nextLine - 1).join("\n");
    if (!content.trim()) continue;
    const breadcrumb = `# File: ${filePath}\n# Key: ${b.name}`;
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "yaml",
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
