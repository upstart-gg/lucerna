import type { RawEdge } from "../../graph/types.js";
import type { ChunkType, CodeChunk } from "../../types.js";
import { getAbsorb } from "./absorbPresets.js";
import {
  absorbUpward,
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

const OCAML_EXTRA_QUERIES = {
  moduleTypes: `(module_type_definition (module_type_name) @name) @mt`,
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
    chunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type: "import",
      content: importContent,
      contextContent: importContent,
      startLine,
      endLine,
      metadata: {},
    });
    for (const m of openMatches) {
      const raw = cap(m, "imp")?.text ?? "";
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

  const absorb = getAbsorb(language);

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: ChunkType,
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumb = `(* ${capitalize(type)}: ${name} *)`;
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
      startLine: startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  };

  // --- Modules (including functors) ---
  for (const m of getMatches("modules")) {
    const node = cap(m, "mod")?.node;
    if (!node) continue;
    const text = cap(m, "mod")?.text ?? "";
    const name = text.match(/^module\s+(\w+)/)?.[1] ?? "";
    if (!name) continue;
    // Functor: `module Foo (X : SIG) = ...` or explicit `functor` keyword
    const isFunctor =
      /\bfunctor\b/.test(text) || /^module\s+\w+\s*\(/.test(text);
    addChunk(node, name, isFunctor ? "functor" : "module");
  }

  // --- Module types ---
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
    const ex: any = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(OCAML_EXTRA_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
    const exR = ex.results as Record<string, { matches: PatternMatch[] }>;
    for (const m of exR.moduleTypes?.matches ?? []) {
      const node = cap(m, "mt")?.node;
      const name = cap(m, "name")?.text ?? "";
      if (node && name) addChunk(node, name, "module_type");
    }
  } catch {
    /* OCaml extras unsupported — skip */
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
