import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const CLOJURE_QUERIES = {
  // (defn name ...) / (defn- name ...) / (defmacro name ...)
  defns: `(list_lit . (sym_lit) @def . (sym_lit) @name) @form`,
  // (ns my.namespace ...) — the entire ns form is the import chunk
  ns: `(list_lit . (sym_lit) @def . (sym_lit) @name) @form`,
  callExpressions: `(list_lit . (sym_lit) @callee) @call`,
};

export function extractClojure(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "clojure";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(CLOJURE_QUERIES).map(([k, q]) => [
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

  // --- Import chunk: the ns form ---
  let importContent = "";
  const nsMatches = getMatches("ns").filter(
    (m) => (cap(m, "def")?.text ?? "") === "ns",
  );
  const nsMatch = nsMatches[0];
  if (nsMatch) {
    const nsNode = cap(nsMatch, "form")?.node;
    if (nsNode) {
      const startLine = nsNode.startRow + 1;
      const endLine = nsNode.endRow + 1;
      importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
      const breadcrumb = `; File: ${filePath}`;
      chunks.push({
        id: "",
        projectId,
        filePath,
        language,
        type: "import",
        content: importContent,
        contextContent: `${breadcrumb}\n\n${importContent}`,
        startLine,
        endLine,
        metadata: { breadcrumb },
      });
      // Extract required namespaces from the ns form text using a regex
      for (const match of importContent.matchAll(
        /\[([a-z][a-z0-9._-]*(?:\.[a-z][a-z0-9._-]*)*)/g,
      )) {
        const mod = match[1];
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
  }

  // defn / defn- / defmacro
  const defNames = new Set(["defn", "defn-", "defmacro"]);
  for (const m of getMatches("defns").filter((m) =>
    defNames.has(cap(m, "def")?.text ?? ""),
  )) {
    const fnNode = cap(m, "form")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    const content = sourceLines
      .slice(fnNode.startRow, fnNode.endRow + 1)
      .join("\n");
    const breadcrumb = `; File: ${filePath}\n; Function: ${name}`;
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "function",
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: fnNode.startRow + 1,
      endLine: fnNode.endRow + 1,
      metadata: { breadcrumb },
    });
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
        c.type === "function" &&
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
