import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk } from "../../types.js";
import { getAbsorb } from "./absorbPresets.js";
import {
  absorbUpward,
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

// Advanced DDL queries — grammar support varies; run in a separate try so
// failure here doesn't invalidate the core SQL_QUERIES extraction.
const SQL_EXTRA_QUERIES = {
  createFunction: `(statement (create_function (object_reference name: (identifier) @name))) @stmt`,
  createProcedure: `(statement (create_procedure (object_reference name: (identifier) @name))) @stmt`,
  createTrigger: `(statement (create_trigger (object_reference name: (identifier) @name))) @stmt`,
  createIndex: `(statement (create_index (object_reference name: (identifier) @name))) @stmt`,
  createSchema: `(statement (create_schema (object_reference name: (identifier) @name))) @stmt`,
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
    createFunction: "CREATE FUNCTION",
    createProcedure: "CREATE PROCEDURE",
    createTrigger: "CREATE TRIGGER",
    createIndex: "CREATE INDEX",
    createSchema: "CREATE SCHEMA",
    selectStmt: "SELECT",
    insertStmt: "INSERT",
    updateStmt: "UPDATE",
    deleteStmt: "DELETE",
  };
  const stmtType: Record<string, ChunkType> = {
    createTable: "struct",
    createView: "type",
    createFunction: "function",
    createProcedure: "function",
    createTrigger: "type",
    createIndex: "type",
    createSchema: "namespace",
  };

  const absorb = getAbsorb("sql");
  const chunks: CodeChunk[] = [];
  const seenRows = new Set<number>();

  // Attempt advanced DDL queries in a separate try — grammar support varies.
  let extraResults: Record<string, { matches: PatternMatch[] }> = {};
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language: "sql",
      patterns: Object.fromEntries(
        Object.entries(SQL_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    extraResults = ex.results;
  } catch {
    /* grammar doesn't support advanced DDL — skip */
  }

  const allKeys = [
    ...Object.keys(SQL_QUERIES),
    ...Object.keys(SQL_EXTRA_QUERIES),
  ];
  for (const key of allKeys) {
    const matches =
      key in SQL_QUERIES ? getMatches(key) : (extraResults[key]?.matches ?? []);
    for (const m of matches) {
      const stmtNode = cap(m, "stmt")?.node;
      if (!stmtNode || seenRows.has(stmtNode.startRow)) continue;
      seenRows.add(stmtNode.startRow);
      const nameCap = cap(m, "name");
      const startRow = absorb
        ? absorbUpward(sourceLines, stmtNode.startRow, absorb)
        : stmtNode.startRow;
      const content = sourceLines
        .slice(startRow, stmtNode.endRow + 1)
        .join("\n");
      const label = stmtLabel[key] ?? "SQL";
      const chunkName = nameCap?.text ? `${label} ${nameCap.text}` : label;
      const breadcrumb = `// ${chunkName}`;
      chunks.push({
        id: "",
        projectId,
        filePath,
        language: "sql",
        type: stmtType[key] ?? "file",
        name: chunkName,
        content,
        contextContent: `${breadcrumb}\n\n${content}`,
        startLine: startRow + 1,
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
