import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as languagePack from "@kreuzberg/tree-sitter-language-pack";
import type { ChunkingWithEdgesResult, RawEdge } from "../graph/types.js";
import type { CodeChunk, Language } from "../types.js";
import { extractBash } from "./languages/bash.js";
import { extractC } from "./languages/c.js";
import { extractClojure } from "./languages/clojure.js";
import { extractCpp } from "./languages/cpp.js";
import { extractCSharp } from "./languages/csharp.js";
import { extractDart } from "./languages/dart.js";
import { extractElixir } from "./languages/elixir.js";
import { extractGo } from "./languages/go.js";
import { extractGroovy } from "./languages/groovy.js";
import { extractHaskell } from "./languages/haskell.js";
import { extractJava } from "./languages/java.js";
import { processJson } from "./languages/json.js";
import { extractKotlin } from "./languages/kotlin.js";
import { extractLua } from "./languages/lua.js";
import { extractMarkdown } from "./languages/markdown.js";
import { extractMatlab } from "./languages/matlab.js";
import { extractPerl } from "./languages/perl.js";
import { extractPhp } from "./languages/php.js";
import { extractPowerShell } from "./languages/powershell.js";
import { extractPython } from "./languages/python.js";
import { extractR } from "./languages/r.js";
import { extractRuby } from "./languages/ruby.js";
import { extractRust } from "./languages/rust.js";
import { extractScala } from "./languages/scala.js";
import { extractSolidity } from "./languages/solidity.js";
import { extractSql } from "./languages/sql.js";
import { extractSwift } from "./languages/swift.js";
import { extractTsJs } from "./languages/typescript.js";
import { extractXml } from "./languages/xml.js";
import { extractZig } from "./languages/zig.js";

// Languages pre-initialized with the language pack (all tree-sitter grammars)
const DEFAULT_LANGUAGES = ["typescript", "javascript", "json"];

// Aliases: some pack language names need mapping to our canonical names
const LANGUAGE_ALIASES: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  sh: "bash",
  shellscript: "bash",
};

export interface ChunkerOptions {
  maxChunkTokens?: number;
  /** Minimum chunk size in tokens. Adjacent siblings that are both below this
   * threshold are merged into one chunk to avoid low-quality micro-embeddings
   * (e.g. a class with 10 trivial one-liner getters). Defaults to 0 (disabled).
   * A value of 50 (≈ 200 chars) is a reasonable starting point. */
  minChunkTokens?: number;
}

/**
 * AST-based file chunker. Uses @kreuzberg/tree-sitter-language-pack to parse
 * source files and extract semantically meaningful chunks (functions, classes,
 * sections, etc.). Custom chunkers for popular languages; files in any other language
 * return no chunks.
 *
 * Markdown is handled via a regex-based extractor (no grammar needed).
 * TypeScript/JavaScript use extract() with tree-sitter queries for full fidelity.
 */
export class TreeSitterChunker {
  private maxChunkTokens: number;
  private minMergeChars: number;
  /** Languages that have been passed to packInit and are ready to use. */
  private initializedLanguages: Set<string> = new Set();
  /**
   * All languages listed in the pack manifest. Populated once in initialize().
   * Used instead of hasLanguage() to guard lazy-init: hasLanguage() only returns
   * true for already-cached grammars, so it silently skips valid languages on a
   * cold cache (e.g. a fresh CI runner). manifestLanguages() reflects the full
   * set of supported languages regardless of local cache state.
   */
  private supportedLanguages: Set<string> = new Set();
  private initialized = false;

  constructor(options: ChunkerOptions = {}) {
    this.maxChunkTokens = options.maxChunkTokens ?? 1500;
    // chars ≈ tokens * 4; 0 means merging is disabled (default)
    this.minMergeChars = (options.minChunkTokens ?? 0) * 4;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Cache the manifest once so the lazy-init guard below doesn't need to call
    // hasLanguage(), which requires the grammar to already be cached locally.
    for (const lang of languagePack.manifestLanguages()) {
      this.supportedLanguages.add(lang);
    }
    // Pre-warm the default languages; all others are initialized lazily on first encounter.
    languagePack.init({ languages: DEFAULT_LANGUAGES });
    for (const lang of DEFAULT_LANGUAGES) this.initializedLanguages.add(lang);
    // markdown is handled inline (no grammar needed)
    this.initializedLanguages.add("markdown");
    this.initialized = true;
  }

  static detectLanguage(filePath: string): Language | null {
    const raw = languagePack.detectLanguage(filePath);
    if (!raw) return null;
    return LANGUAGE_ALIASES[raw] ?? raw;
  }

  async chunkFile(
    filePath: string,
    projectId: string,
    language?: Language,
  ): Promise<CodeChunk[]> {
    const lang = language ?? TreeSitterChunker.detectLanguage(filePath);
    if (!lang) return [];
    const source = await readFile(filePath, "utf8");
    return this.chunkSource(source, filePath, projectId, lang);
  }

  async chunkSource(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<CodeChunk[]> {
    const { chunks } = await this.chunkSourceInternal(
      source,
      filePath,
      projectId,
      language,
    );
    return chunks;
  }

  /**
   * Chunk a file and also extract raw knowledge-graph edges.
   */
  async chunkFileWithEdges(
    filePath: string,
    projectId: string,
    language?: Language,
  ): Promise<ChunkingWithEdgesResult> {
    const lang = language ?? TreeSitterChunker.detectLanguage(filePath);
    if (!lang) return { chunks: [], rawEdges: [] };
    const source = await readFile(filePath, "utf8");
    return this.chunkSourceWithEdges(source, filePath, projectId, lang);
  }

  /**
   * Chunk source text and also extract raw knowledge-graph edges.
   */
  async chunkSourceWithEdges(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<ChunkingWithEdgesResult> {
    return this.chunkSourceInternal(source, filePath, projectId, language);
  }

  // kept for API compatibility — no cleanup needed with the native addon
  async close(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Core implementation — always returns both chunks and edges
  // ---------------------------------------------------------------------------

  private async chunkSourceInternal(
    source: string,
    filePath: string,
    projectId: string,
    language: Language,
  ): Promise<ChunkingWithEdgesResult> {
    if (!this.initialized) {
      throw new Error("TreeSitterChunker.initialize() must be called first");
    }

    // Markdown is handled inline — no grammar initialization needed.
    // For all other languages, lazily initialize via packInit on first encounter.
    if (language !== "markdown" && !this.initializedLanguages.has(language)) {
      // Guard against truly unsupported languages using the manifest, not hasLanguage().
      // hasLanguage() returns false for languages that haven't been downloaded to the
      // local cache yet — this would silently produce 0 chunks on a cold cache (CI).
      // manifestLanguages() reflects all supported languages regardless of cache state.
      if (!this.supportedLanguages.has(language)) {
        return { chunks: [], rawEdges: [] };
      }
      // packInit downloads + initializes the grammar; safe to call from concurrent
      // Promise.all paths — no await means JS won't context-switch mid-block.
      languagePack.init({ languages: [language] });
      this.initializedLanguages.add(language);
    }

    let chunks: CodeChunk[];
    let rawEdges: RawEdge[];

    if (language === "markdown") {
      chunks = extractMarkdown(
        source,
        filePath,
        projectId,
        this.maxChunkTokens * 4,
      );
      rawEdges = [];
    } else if (language === "json") {
      ({ chunks, rawEdges } = processJson(
        source,
        filePath,
        projectId,
        this.maxChunkTokens,
      ));
    } else if (language === "typescript" || language === "javascript") {
      ({ chunks, rawEdges } = extractTsJs(
        source,
        filePath,
        projectId,
        language,
        this.minMergeChars,
      ));
    } else if (language === "go") {
      ({ chunks, rawEdges } = extractGo(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "csharp") {
      ({ chunks, rawEdges } = extractCSharp(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "swift") {
      ({ chunks, rawEdges } = extractSwift(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "kotlin") {
      ({ chunks, rawEdges } = extractKotlin(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "ruby") {
      ({ chunks, rawEdges } = extractRuby(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "php") {
      ({ chunks, rawEdges } = extractPhp(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "c") {
      ({ chunks, rawEdges } = extractC(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "cpp") {
      ({ chunks, rawEdges } = extractCpp(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "sql") {
      ({ chunks, rawEdges } = extractSql(source, filePath, projectId));
    } else if (language === "python") {
      ({ chunks, rawEdges } = extractPython(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "bash") {
      ({ chunks, rawEdges } = extractBash(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "java") {
      ({ chunks, rawEdges } = extractJava(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "rust") {
      ({ chunks, rawEdges } = extractRust(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "lua") {
      ({ chunks, rawEdges } = extractLua(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "xml") {
      ({ chunks, rawEdges } = extractXml(source, filePath, projectId));
    } else if (language === "r") {
      ({ chunks, rawEdges } = extractR(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "scala") {
      ({ chunks, rawEdges } = extractScala(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "dart") {
      ({ chunks, rawEdges } = extractDart(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "perl") {
      ({ chunks, rawEdges } = extractPerl(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "haskell") {
      ({ chunks, rawEdges } = extractHaskell(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "elixir") {
      ({ chunks, rawEdges } = extractElixir(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "clojure") {
      ({ chunks, rawEdges } = extractClojure(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "powershell") {
      ({ chunks, rawEdges } = extractPowerShell(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "matlab") {
      ({ chunks, rawEdges } = extractMatlab(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "groovy") {
      ({ chunks, rawEdges } = extractGroovy(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "zig") {
      ({ chunks, rawEdges } = extractZig(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else if (language === "solidity") {
      ({ chunks, rawEdges } = extractSolidity(
        source,
        filePath,
        projectId,
        this.minMergeChars,
      ));
    } else {
      return { chunks: [], rawEdges: [] };
    }

    for (const chunk of chunks) {
      if (!chunk.id) {
        chunk.id = hashChunkId(
          chunk.projectId,
          chunk.filePath,
          chunk.startLine,
        );
      }
    }

    // Fill in sourceChunkId for edges that haven't had it set yet
    // (uses the first chunk as fallback — import chunk if present)
    const firstId = chunks[0]?.id;
    if (firstId) {
      for (const edge of rawEdges) {
        if (!edge.sourceChunkId) edge.sourceChunkId = firstId;
      }
    }

    // DEFINES edges: import chunk → each named chunk (all languages)
    {
      const importChunk = chunks.find((c) => c.type === "import");
      if (importChunk?.id) {
        for (const chunk of chunks) {
          if (chunk.type !== "import" && chunk.name && chunk.id) {
            rawEdges.push({
              sourceChunkId: importChunk.id,
              sourceFilePath: filePath,
              type: "DEFINES",
              targetSymbol: chunk.id,
              metadata: {},
            });
          }
        }
      }
    }

    return { chunks, rawEdges };
  }
}

export function hashChunkId(
  projectId: string,
  filePath: string,
  startLine: number,
): string {
  return createHash("sha1")
    .update(`${projectId}:${filePath}:${startLine}`)
    .digest("hex")
    .slice(0, 16);
}
