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

// The tree-sitter-zig grammar uses CamelCase node names (VarDecl, FnProto,
// TestDecl, ContainerDecl). VarDecl text is regex-scanned for @import to
// detect imports, since the grammar exposes builtins as BUILTINIDENTIFIER
// without a structured argument hierarchy.
const ZIG_QUERIES = {
  varDecls: `(VarDecl (IDENTIFIER) @name) @decl`,
  fns: `(_ (FnProto (IDENTIFIER) @name)) @fn`,
  tests: `(TestDecl) @test`,
};

export function extractZig(
  source: string,
  filePath: string,
  projectId: string,
  minMergeChars = 0,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "zig";

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(ZIG_QUERIES).map(([k, q]) => [
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

  // --- Import chunk (@import declarations detected by text) ---
  let importContent = "";
  const allVarDecls = getMatches("varDecls");
  const importDecls = allVarDecls.filter((m) =>
    /@import\s*\(/.test(cap(m, "decl")?.text ?? ""),
  );
  if (importDecls.length > 0) {
    const nodes = importDecls
      .map((m) => cap(m, "decl")?.node)
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
    for (const m of importDecls) {
      const text = cap(m, "decl")?.text ?? "";
      const mod = text.match(/@import\s*\(\s*["']([^"']+)["']/)?.[1] ?? "";
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
    const breadcrumb = `// ${capitalize(type)}: ${name}`;
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

  // Containers (struct / enum / union declared via `const X = <kind> { ... }`).
  // Detect by inspecting VarDecl text; the grammar exposes ContainerDecl but
  // not its kind via a clean field, so text matching is the reliable path.
  for (const m of allVarDecls) {
    const node = cap(m, "decl")?.node;
    const name = cap(m, "name")?.text ?? "";
    const text = cap(m, "decl")?.text ?? "";
    if (!node || !name) continue;
    if (/@import\s*\(/.test(text)) continue; // already an import
    const containerMatch = text.match(
      /=\s*(?:packed\s+|extern\s+)?(struct|enum|union)\b/,
    );
    if (!containerMatch) continue;
    const kind = containerMatch[1];
    const type: ChunkType = kind === "enum" ? "enum" : "struct";
    addChunk(node, name, type);
  }

  for (const m of getMatches("tests")) {
    const node = cap(m, "test")?.node;
    if (!node) continue;
    const text = cap(m, "test")?.text ?? "";
    const name = text.match(/^test\s+"([^"]+)"/)?.[1] ?? "anonymous";
    addChunk(node, name, "test");
  }

  for (const m of getMatches("fns")) {
    const fnNode = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!fnNode || !name) continue;
    let parentName: string | undefined;
    for (const chunk of chunks) {
      if (
        (chunk.type === "struct" || chunk.type === "enum") &&
        chunk.startLine <= fnNode.startRow + 1 &&
        chunk.endLine >= fnNode.endRow + 1
      ) {
        parentName = chunk.name;
        break;
      }
    }
    addChunk(fnNode, name, parentName ? "method" : "function");
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
