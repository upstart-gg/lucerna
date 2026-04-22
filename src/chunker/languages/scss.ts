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

const SCSS_QUERIES = {
  rules: `(rule_set (selectors) @sel) @rule`,
  mixins: `(mixin_statement name: (identifier) @name) @mixin`,
  functions: `(function_statement name: (identifier) @name) @fn`,
};

// tree-sitter-scss exposes SCSS variable declarations as ordinary `declaration`
// nodes whose `property_name` happens to start with `$`. There's no dedicated
// `variable_name` node — we filter on the `$` prefix below.
const SCSS_EXTRA_QUERIES = {
  variables: `(declaration (property_name) @name) @var`,
  keyframes: `(keyframes_statement (keyframes_name) @name) @kf`,
  media: `(media_statement) @media`,
};

const MIN_VAR_CHARS = 30;

export function extractScss(
  source: string,
  filePath: string,
  projectId: string,
): { chunks: CodeChunk[]; rawEdges: RawEdge[] } {
  const sourceLines = source.split("\n");
  const language = "scss";
  const rawEdges: RawEdge[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
  let extracted: any;
  try {
    extracted = packExtract(source, {
      language,
      patterns: Object.fromEntries(
        Object.entries(SCSS_QUERIES).map(([k, q]) => [
          k,
          { query: q, captureOutput: "Full" },
        ]),
      ),
    });
  } catch {
    return {
      chunks: [makeFileChunk(source, filePath, projectId, language)],
      rawEdges,
    };
  }

  const results = extracted.results as Record<
    string,
    { matches: PatternMatch[] }
  >;
  const cap = (match: PatternMatch, name: string): MatchCapture | undefined =>
    match.captures.find((c) => c.name === name);

  const ruleMatches = results.rules?.matches ?? [];
  const mixinMatches = results.mixins?.matches ?? [];
  const fnMatches = results.functions?.matches ?? [];

  const absorb = getAbsorb(language);
  const allChunks: CodeChunk[] = [];

  const addChunk = (
    node: NonNullable<MatchCapture["node"]>,
    name: string,
    type: ChunkType,
    breadcrumbLabel: string,
  ) => {
    const startRow = absorb
      ? absorbUpward(sourceLines, node.startRow, absorb)
      : node.startRow;
    const content = sourceLines.slice(startRow, node.endRow + 1).join("\n");
    const breadcrumb = `/* ${breadcrumbLabel}: ${name} */`;
    allChunks.push({
      id: "",
      projectId,
      filePath,
      language,
      type,
      name,
      content,
      contextContent: `${breadcrumb}\n\n${content}`,
      startLine: startRow + 1,
      endLine: node.endRow + 1,
      metadata: { breadcrumb },
    });
  };

  // Mixins and functions — always chunked
  for (const m of mixinMatches) {
    const node = cap(m, "mixin")?.node;
    const name = cap(m, "name")?.text ?? "mixin";
    if (node) addChunk(node, name, "function", "Mixin");
  }
  for (const m of fnMatches) {
    const node = cap(m, "fn")?.node;
    const name = cap(m, "name")?.text ?? "function";
    if (node) addChunk(node, name, "function", "Function");
  }

  // Variables, keyframes, media — each runs in its own batch so a single
  // grammar miss doesn't sink the others.
  const tryExtra = (key: keyof typeof SCSS_EXTRA_QUERIES): PatternMatch[] => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: runtime type from native addon
      const ex: any = packExtract(source, {
        language,
        patterns: {
          [key]: { query: SCSS_EXTRA_QUERIES[key], captureOutput: "Full" },
        },
      });
      return (ex.results[key]?.matches as PatternMatch[]) ?? [];
    } catch {
      return [];
    }
  };

  for (const m of tryExtra("variables")) {
    const node = cap(m, "var")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (!node || !name) continue;
    if (!name.startsWith("$")) continue;
    const content = sourceLines
      .slice(node.startRow, node.endRow + 1)
      .join("\n");
    if (content.length < MIN_VAR_CHARS) continue;
    addChunk(node, name, "const", "Variable");
  }
  for (const m of tryExtra("keyframes")) {
    const node = cap(m, "kf")?.node;
    const name = cap(m, "name")?.text ?? "";
    if (node && name) addChunk(node, name, "function", "Keyframes");
  }
  for (const m of tryExtra("media")) {
    const node = cap(m, "media")?.node;
    if (!node) continue;
    addChunk(node, "media", "section", "Media");
  }

  // Add rule chunks if there are enough rules to warrant splitting
  if (ruleMatches.length > 3) {
    for (const m of ruleMatches) {
      const node = cap(m, "rule")?.node;
      const selector = cap(m, "sel")?.text?.trim() ?? "rule";
      if (!node) continue;
      addChunk(node, selector, "section", "Selector");
    }
  }

  if (allChunks.length > 0) return { chunks: allChunks, rawEdges };

  return {
    chunks: [makeFileChunk(source, filePath, projectId, language)],
    rawEdges,
  };
}
