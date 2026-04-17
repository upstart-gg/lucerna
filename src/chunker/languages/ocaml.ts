import type { RawEdge } from "../../graph/types.js";
import type { CodeChunk } from "../../types.js";
import {
  capitalize,
  mergeSiblingChunks,
  packExtract,
  processWithPack,
  type MatchCapture,
  type PatternMatch,
} from "./shared.js";

const OCAML_QUERIES = {
  opens: `(open_module) @imp`,
  lets: `(value_definition (let_binding pattern: (value_name) @name)) @fn`,
  types: `(type_definition (type_binding name: (type_constructor) @name)) @type`,
  modules: `(module_definition) @mod`,
};

export function extractOcaml(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "ocaml";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(OCAML_QUERIES).map(([k, q]) => [
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

  // --- Import chunk from open statements ---
  let importContent = "";
  const openMatches = getMatches("opens");
  if (openMatches.length > 0) {
    const nodes = openMatches
      .map((m) => cap(m, "imp")?.node)
      .filter((n): n is NonNullable<typeof n> => n != null);
    const startLine = Math.min(...nodes.map((n) => n.startRow)) + 1;
    const endLine = Math.max(...nodes.map((n) => n.endRow)) + 1;
    importContent = sourceLines.slice(startLine - 1, endLine).join("\n");
    const breadcrumb = `// File: ${filePath}`;
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
    for (const m of openMatches) {
      const raw = cap(m, "imp")?.text ?? "";
      // "open Printf" → "Printf"
      const mod = raw.replace(/^open\s+/, "").trim();
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

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: "function" | "type" | "class",
  ) => {
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    const breadcrumb = `// File: ${filePath}\n// ${capitalize(type)}: ${name}`;
    const contextParts = [breadcrumb];
    if (importContent) contextParts.push(importContent);
    contextParts.push(content);
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type,
      name,
      content,
      contextContent: contextParts.join("\n\n"),
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  };

  // --- Modules ---
  for (const m of getMatches("modules")) {
    const node = cap(m, "mod")?.node;
    if (!node) continue;
    const text = cap(m, "mod")?.text ?? "";
    const name = text.match(/^module\s+(\w+)/)?.[1] ?? "";
    if (name) addChunk(node, name, "class");
  }

  // --- Let bindings (functions / values) ---
  for (const m of getMatches("lets")) {
    const node = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "function");
  }

  // --- Type definitions ---
  for (const m of getMatches("types")) {
    const node = cap(m, "type")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "type");
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

  return { chunks: mergeSiblingChunks(chunks, minMergeChars), rawEdges };
}
