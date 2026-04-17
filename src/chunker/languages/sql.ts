import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  makeFileChunk,
  packExtract,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const SQL_QUERIES = {
  createTable: `(statement (create_table (object_reference name: (identifier) @name))) @stmt`,
  createView: `(statement (create_view (object_reference name: (identifier) @name))) @stmt`,
  selectStmt: `(statement (select)) @stmt`,
  insertStmt: `(statement (insert)) @stmt`,
  updateStmt: `(statement (update)) @stmt`,
  deleteStmt: `(statement (delete)) @stmt`,
};

export function extractSql(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language: "sql",
      patterns: Object.fromEntries(
        Object.entries(SQL_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, "sql")],
      rawEdges: [],
    };
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;
  const getMatches = (key: string): PatternMatch[] =>
    results[key]?.matches ?? [];
  const cap = (match: PatternMatch, name: string): MatchCapture | undefined =>
    match.captures.find((c) => c.name === name);

  const stmtLabel: Record<string, string> = {
    createTable: "CREATE TABLE",
    createView: "CREATE VIEW",
    selectStmt: "SELECT",
    insertStmt: "INSERT",
    updateStmt: "UPDATE",
    deleteStmt: "DELETE",
  };

  const chunks: CodeChunk[] = [];
  const seenRows = new Set<number>();

  for (const key of Object.keys(SQL_QUERIES)) {
    for (const m of getMatches(key)) {
      const stmtNode = cap(m, "stmt")?.node;
      if (!stmtNode || seenRows.has(stmtNode.startRow)) continue;
      seenRows.add(stmtNode.startRow);
      const nameCap = cap(m, "name");
      const content = sourceLines
        .slice(stmtNode.startRow, stmtNode.endRow + 1)
        .join("\n");
      const label = stmtLabel[key] ?? "SQL";
      const chunkName = nameCap?.text ? `${label} ${nameCap.text}` : label;
      const breadcrumb = `// File: ${filePath}\n// ${chunkName}`;
      chunks.push({
        id: "",
        projectId,
        filePath,
        language: "sql",
        type: "file",
        name: chunkName,
        content,
        contextContent: `${breadcrumb}\n\n${content}`,
        startLine: stmtNode.startRow + 1,
        endLine: stmtNode.endRow + 1,
        metadata: { breadcrumb },
      });
    }
  }

  chunks.sort((a, b) => a.startLine - b.startLine);

  if (chunks.length === 0) {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, "sql")],
      rawEdges: [],
    };
  }
  return { chunks, rawEdges: [] };
}
