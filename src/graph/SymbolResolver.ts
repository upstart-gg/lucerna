import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { CodeChunk, GraphEdge } from "../types.js";
import { hashEdgeId } from "./types.js";
import type { RawEdge } from "./types.js";

// ---------------------------------------------------------------------------
// tsconfig path alias support
// ---------------------------------------------------------------------------

interface PathAlias {
  pattern: string;
  /** Resolved absolute target paths (may contain "*" wildcard placeholder) */
  targets: string[];
  isWildcard: boolean;
}

// ---------------------------------------------------------------------------
// SymbolResolver
// ---------------------------------------------------------------------------

/**
 * Converts RawEdges (unresolved) into GraphEdges (resolved) by:
 *   1. Loading tsconfig.json to support path aliases (e.g. "@/*" → "src/*"),
 *      following `extends` chains recursively.
 *   2. Building an export map from all indexed chunks
 *   3. Resolving each raw edge's targetSymbol + targetFilePath to a real chunkId
 */
export class SymbolResolver {
  private readonly projectRoot: string;
  private pathAliases: PathAlias[] = [];
  private pathsLoaded = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  // ---------------------------------------------------------------------------
  // tsconfig paths loading
  // ---------------------------------------------------------------------------

  private async ensurePathsLoaded(): Promise<void> {
    if (this.pathsLoaded) return;
    this.pathsLoaded = true;
    await this.loadTsConfigPaths();
  }

  private async loadTsConfigPaths(): Promise<void> {
    const candidates = [
      resolve(this.projectRoot, "tsconfig.json"),
      resolve(this.projectRoot, "tsconfig.base.json"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        await this.collectTsConfigPaths(candidate, new Set());
        break;
      }
    }
  }

  /**
   * Recursively loads path aliases from a tsconfig file, following `extends`.
   * The starting file's aliases take priority — they are added first, and
   * inherited aliases are only appended when their pattern is not yet present.
   */
  private async collectTsConfigPaths(
    configPath: string,
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(configPath)) return;
    visited.add(configPath);

    let config: {
      extends?: string | string[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    try {
      const raw = await readFile(configPath, "utf8");
      // tsconfig allows JS-style comments; strip them before JSON.parse
      const stripped = raw
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      config = JSON.parse(stripped) as typeof config;
    } catch {
      return; // If the file can't be read/parsed, skip silently
    }

    const configDir = dirname(configPath);
    const opts = config.compilerOptions;

    // Add paths from this config. Since we process the root config first, its
    // patterns win: skip any pattern that was already registered.
    if (opts?.paths) {
      const baseUrl = opts.baseUrl
        ? resolve(configDir, opts.baseUrl)
        : configDir;
      for (const [pattern, targets] of Object.entries(opts.paths)) {
        if (!this.pathAliases.some((a) => a.pattern === pattern)) {
          this.pathAliases.push({
            pattern,
            targets: targets.map((t) => resolve(baseUrl, t)),
            isWildcard: pattern.includes("*"),
          });
        }
      }
    }

    // Follow `extends` to pick up inherited aliases
    const extendsField = config.extends;
    if (!extendsField) return;

    const extendsList = Array.isArray(extendsField)
      ? extendsField
      : [extendsField];
    for (const ext of extendsList) {
      let extPath = resolve(configDir, ext);
      if (!extPath.endsWith(".json")) extPath += ".json";
      if (existsSync(extPath)) {
        await this.collectTsConfigPaths(extPath, visited);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Import path resolution
  // ---------------------------------------------------------------------------

  private applyPathAliases(specifier: string): string | null {
    for (const alias of this.pathAliases) {
      if (alias.isWildcard) {
        const star = alias.pattern.indexOf("*");
        const prefix = alias.pattern.slice(0, star);
        const suffix = alias.pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
          const captured = specifier.slice(
            prefix.length,
            specifier.length - suffix.length || undefined,
          );
          const target = alias.targets[0];
          if (!target) continue;
          return target.replace("*", captured);
        }
      } else if (specifier === alias.pattern) {
        return alias.targets[0] ?? null;
      }
    }
    return null;
  }

  private probeExtensions(base: string): string | null {
    const ext = extname(base);
    if (ext) {
      // Already has an extension — check for .js → .ts remapping (common in compiled TS)
      if (existsSync(base)) return base;
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        for (const tsExt of [".ts", ".tsx", ".mts", ".cts"]) {
          const variant = base.slice(0, -ext.length) + tsExt;
          if (existsSync(variant)) return variant;
        }
      }
      return null;
    }

    const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
    for (const probe of EXTS) {
      if (existsSync(base + probe)) return base + probe;
    }
    // Try index files
    for (const idxFile of ["index.ts", "index.tsx", "index.js"]) {
      const p = join(base, idxFile);
      if (existsSync(p)) return p;
    }
    return null;
  }

  async resolveImportPath(
    specifier: string,
    fromFile: string,
  ): Promise<string | null> {
    await this.ensurePathsLoaded();
    // 1. Try path aliases (tsconfig paths)
    const aliased = this.applyPathAliases(specifier);
    if (aliased !== null) return this.probeExtensions(aliased);

    // 2. Relative imports
    if (specifier.startsWith(".")) {
      const fromDir = dirname(resolve(this.projectRoot, fromFile));
      return this.probeExtensions(resolve(fromDir, specifier));
    }

    // 3. Non-relative, non-aliased → external package, cannot resolve
    return null;
  }

  // ---------------------------------------------------------------------------
  // Export map construction
  // ---------------------------------------------------------------------------

  buildExportMap(chunks: CodeChunk[]): Map<string, Map<string, string>> {
    // absoluteFilePath → symbolName → chunkId
    const exportMap = new Map<string, Map<string, string>>();

    for (const chunk of chunks) {
      if (!chunk.name || chunk.type === "import") continue;
      const absPath = resolve(this.projectRoot, chunk.filePath);

      let fileMap = exportMap.get(absPath);
      if (!fileMap) {
        fileMap = new Map();
        exportMap.set(absPath, fileMap);
      }

      fileMap.set(chunk.name, chunk.id);

      // For "Class#method" names also register the short method name
      const hash = chunk.name.indexOf("#");
      if (hash !== -1) {
        const shortName = chunk.name.slice(hash + 1);
        if (!fileMap.has(shortName)) fileMap.set(shortName, chunk.id);
      }
    }

    return exportMap;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  async resolveAll(
    rawEdges: RawEdge[],
    allChunks: CodeChunk[],
    projectId: string,
  ): Promise<GraphEdge[]> {
    await this.ensurePathsLoaded();

    const exportMap = this.buildExportMap(allChunks);

    // filePath (relative) → import chunk ID
    const importChunkByFile = new Map<string, string>();
    for (const chunk of allChunks) {
      if (chunk.type === "import")
        importChunkByFile.set(chunk.filePath, chunk.id);
    }

    const resolved: GraphEdge[] = [];
    const seen = new Set<string>();

    for (const raw of rawEdges) {
      let targetChunkId: string | null = null;

      if (raw.type === "DEFINES") {
        // targetSymbol already holds the resolved target chunk ID
        targetChunkId = raw.targetSymbol;
      } else if (raw.type === "IMPORTS" && raw.targetFilePath) {
        const absTarget = await this.resolveImportPath(
          raw.targetFilePath,
          raw.sourceFilePath,
        );
        if (absTarget) {
          const relTarget = relative(this.projectRoot, absTarget);
          // Prefer the import chunk; fall back to first known symbol from that file
          targetChunkId =
            importChunkByFile.get(relTarget) ??
            firstValue(exportMap.get(absTarget)) ??
            null;
        }
      } else if (raw.targetFilePath) {
        // Symbol edge with a file hint (e.g. CALLS/USES/EXTENDS from a file we know about)
        const absTarget = await this.resolveImportPath(
          raw.targetFilePath,
          raw.sourceFilePath,
        );
        if (absTarget) {
          targetChunkId =
            exportMap.get(absTarget)?.get(raw.targetSymbol) ?? null;
        }
      } else {
        // No file hint — search all files for the symbol name.
        // To reduce false positives, skip the source file itself.
        const sourceAbsPath = resolve(this.projectRoot, raw.sourceFilePath);
        for (const [absPath, fileMap] of exportMap) {
          if (absPath === sourceAbsPath) continue;
          const candidate = fileMap.get(raw.targetSymbol);
          if (candidate) {
            targetChunkId = candidate;
            break;
          }
        }
      }

      if (!targetChunkId || targetChunkId === raw.sourceChunkId) continue;

      const edgeId = hashEdgeId(
        projectId,
        raw.sourceChunkId,
        targetChunkId,
        raw.type,
      );
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);

      resolved.push({
        id: edgeId,
        projectId,
        sourceChunkId: raw.sourceChunkId,
        sourceFilePath: raw.sourceFilePath,
        targetChunkId,
        type: raw.type,
        metadata: raw.metadata,
      });
    }

    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstValue<K, V>(map: Map<K, V> | undefined): V | undefined {
  if (!map) return undefined;
  return map.values().next().value as V | undefined;
}
