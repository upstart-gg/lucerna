#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { CodeIndexer } from "../CodeIndexer.js";
import {
  loadConfig,
  resolveBuiltinEmbedder,
  resolveBuiltinReranker,
} from "../config.js";
import pkg from "../../package.json";
import type {
  CodeChunk,
  ChunkType,
  EmbeddingFunction,
  EvalQuery,
  IndexEvent,
  RerankingFunction,
  SearchResult,
} from "../types.js";

const program = new Command();

program
  .name("lucerna")
  .description("AST-aware semantic + lexical code indexer for AI agents")
  .version(pkg.version);

// ---------------------------------------------------------------------------
// index command
// ---------------------------------------------------------------------------

program
  .command("index <project-root>")
  .description("Index all files in a project (one-shot)")
  .option("--storage-dir <dir>", "Override storage directory")
  .option("--include <globs>", "Comma-separated include glob patterns")
  .option("--exclude <globs>", "Comma-separated exclude glob patterns")
  .option("--no-semantic", "Disable semantic/vector search (lexical only)")
  .option(
    "--embedder <name>",
    "Built-in embedder: cloudflare, local, bge-small, jina-code",
  )
  .option("--reranker <name>", "Built-in reranker: cloudflare, jina, voyage")
  .option("--config <path>", "Path to lucerna.config.ts / lucerna.config.js")
  .action(async (projectRoot: string, opts: Record<string, unknown>) => {
    const indexer = await buildIndexer(projectRoot, opts);
    try {
      await indexer.initialize();
      console.log(`Indexing ${resolve(projectRoot)}...`);
      const stats = await indexer.indexProject();
      console.log(
        `Done. ${stats.totalFiles} files, ${stats.totalChunks} chunks indexed.`,
      );
    } finally {
      await indexer.close();
    }
  });

// ---------------------------------------------------------------------------
// watch command
// ---------------------------------------------------------------------------

program
  .command("watch <project-root>")
  .description("Index a project and watch for file changes")
  .option("--storage-dir <dir>", "Override storage directory")
  .option("--include <globs>", "Comma-separated include glob patterns")
  .option("--exclude <globs>", "Comma-separated exclude glob patterns")
  .option("--no-semantic", "Disable semantic/vector search (lexical only)")
  .option(
    "--embedder <name>",
    "Built-in embedder: cloudflare, local, bge-small, jina-code",
  )
  .option("--reranker <name>", "Built-in reranker: cloudflare, jina, voyage")
  .option("--config <path>", "Path to lucerna.config.ts / lucerna.config.js")
  .option("--debounce <ms>", "Debounce delay in milliseconds", "500")
  .action(async (projectRoot: string, opts: Record<string, unknown>) => {
    const indexer = await buildIndexer(projectRoot, {
      ...opts,
      watch: false, // we start watching manually below so we can log first
      watchDebounce: parseInt(String(opts.debounce ?? "500"), 10),
      onIndexed: (event: IndexEvent) => {
        if (event.type === "indexed") {
          console.log(
            `[indexed] ${event.filePath} (${event.chunksAffected ?? 0} chunks)`,
          );
        } else if (event.type === "removed") {
          console.log(`[removed] ${event.filePath}`);
        } else if (event.type === "error") {
          console.error(`[error]   ${event.filePath}: ${event.error?.message}`);
        }
      },
    });

    try {
      await indexer.initialize();
      console.log(`Indexing ${resolve(projectRoot)}...`);
      const stats = await indexer.indexProject();
      console.log(
        `Initial index complete. ${stats.totalFiles} files, ${stats.totalChunks} chunks.`,
      );
      console.log("Watching for changes. Press Ctrl+C to stop.");
      await indexer.startWatching();

      // Keep alive until SIGINT
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    } finally {
      await indexer.close();
      console.log("\nStopped.");
    }
  });

// ---------------------------------------------------------------------------
// search command
// ---------------------------------------------------------------------------

program
  .command("search <project-root> <query>")
  .description("Search the index for a project")
  .option("--storage-dir <dir>", "Override storage directory")
  .option("--no-semantic", "Disable semantic/vector search")
  .option(
    "--embedder <name>",
    "Built-in embedder: cloudflare, local, bge-small, jina-code",
  )
  .option("--reranker <name>", "Built-in reranker: cloudflare, jina, voyage")
  .option("--config <path>", "Path to lucerna.config.ts / lucerna.config.js")
  .option("--limit <n>", "Max results", "10")
  .option("--format <fmt>", "Output format: raw, json, or pretty-json", "raw")
  .option(
    "--language <lang>",
    "Filter by language (typescript, javascript, json, markdown)",
  )
  .option(
    "--type <type>",
    "Filter by chunk type (function, class, method, ...)",
  )
  .action(
    async (
      projectRoot: string,
      query: string,
      opts: Record<string, unknown>,
    ) => {
      const indexer = await buildIndexer(projectRoot, opts);
      try {
        await indexer.initialize();
        const results = await indexer.search(query, {
          limit: parseInt(String(opts.limit ?? "10"), 10),
          language: opts.language as never,
          ...(opts.type ? { types: [opts.type as ChunkType] } : {}),
        });

        if (results.length === 0) {
          console.log("No results found.");
          return;
        }

        const slim = results.map((r) => {
          const hasContext = Object.keys(r.chunk.metadata).length > 0;
          return {
            id: r.chunk.id,
            file: `${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}`,
            type: r.chunk.type,
            ...(r.chunk.name ? { name: r.chunk.name } : {}),
            ...(hasContext ? { context: r.chunk.metadata } : {}),
            content: r.chunk.content,
          };
        });
        if (opts.format === "json") {
          console.log(JSON.stringify(slim));
        } else if (opts.format === "pretty-json") {
          console.log(JSON.stringify(slim, null, 2));
        } else {
          printList(results);
        }
      } finally {
        await indexer.close();
      }
    },
  );

// ---------------------------------------------------------------------------
// graph command
// ---------------------------------------------------------------------------

program
  .command("graph <project-root> <chunk-id>")
  .description("Explore knowledge graph relationships for a chunk")
  .option("--storage-dir <dir>", "Override storage directory")
  .option(
    "--relation <type>",
    "Relation to traverse: callers, callees, implementors, super-types, usages, neighborhood",
    "neighborhood",
  )
  .option("--depth <n>", "BFS depth for neighborhood", "1")
  .option("--format <fmt>", "Output format: raw, json, or pretty-json", "raw")
  .action(
    async (
      projectRoot: string,
      chunkId: string,
      opts: Record<string, unknown>,
    ) => {
      const indexer = await buildIndexer(projectRoot, {
        ...opts,
        semantic: false,
      });
      try {
        await indexer.initialize();
        const relation = String(opts.relation ?? "neighborhood");

        if (relation === "neighborhood") {
          const depth = parseInt(String(opts.depth ?? "1"), 10);
          const hood = await indexer.getNeighborhood(chunkId, { depth });
          const hoodJson = {
            center: chunkToJson(hood.center),
            related: hood.edges.map((e) => ({
              ...chunkToJson(e.chunk),
              relation: e.edge.type,
              direction: e.direction,
            })),
          };
          if (opts.format === "json") {
            console.log(JSON.stringify(hoodJson));
          } else if (opts.format === "pretty-json") {
            console.log(JSON.stringify(hoodJson, null, 2));
          } else {
            console.log(
              `Center: ${hood.center.filePath}:${hood.center.startLine}  [${hood.center.type}]${hood.center.name ? ` ${hood.center.name}` : ""}`,
            );
            console.log();
            printChunks(
              hood.edges.map((e) => e.chunk),
              hood.edges.map((e) => `${e.edge.type} (${e.direction})`),
            );
          }
          return;
        }

        let chunks: CodeChunk[];
        if (relation === "callers") chunks = await indexer.getCallers(chunkId);
        else if (relation === "callees")
          chunks = await indexer.getCallees(chunkId);
        else if (relation === "implementors")
          chunks = await indexer.getImplementors(chunkId);
        else if (relation === "super-types")
          chunks = await indexer.getSuperTypes(chunkId);
        else if (relation === "usages")
          chunks = await indexer.getUsages(chunkId);
        else {
          console.error(
            `Unknown relation: ${relation}. Valid values: callers, callees, implementors, super-types, usages, neighborhood`,
          );
          process.exit(1);
        }

        if (chunks.length === 0) {
          console.log("No related chunks found.");
          return;
        }
        if (opts.format === "json") {
          console.log(JSON.stringify(chunks.map(chunkToJson)));
        } else if (opts.format === "pretty-json") {
          console.log(JSON.stringify(chunks.map(chunkToJson), null, 2));
        } else {
          printChunks(chunks);
        }
      } finally {
        await indexer.close();
      }
    },
  );

// ---------------------------------------------------------------------------
// stats command
// ---------------------------------------------------------------------------

program
  .command("stats <project-root>")
  .description("Show index statistics for a project")
  .option("--storage-dir <dir>", "Override storage directory")
  .option("--format <fmt>", "Output format: raw, json, or pretty-json", "raw")
  .action(async (projectRoot: string, opts: Record<string, unknown>) => {
    const indexer = await buildIndexer(projectRoot, {
      ...opts,
      semantic: false,
    });
    try {
      await indexer.initialize();
      const stats = await indexer.getStats();
      if (opts.format === "json") {
        console.log(JSON.stringify(stats));
      } else if (opts.format === "pretty-json") {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(`Project:        ${stats.projectRoot}`);
        console.log(`Project ID:     ${stats.projectId}`);
        console.log(`Total files:    ${stats.totalFiles}`);
        console.log(`Total chunks:   ${stats.totalChunks}`);
        console.log(
          `Last indexed:   ${stats.lastIndexed?.toISOString() ?? "never"}`,
        );
      }
    } finally {
      await indexer.close();
    }
  });

// ---------------------------------------------------------------------------
// clear command
// ---------------------------------------------------------------------------

program
  .command("clear <project-root>")
  .description("Clear the stored index for a project")
  .option("--storage-dir <dir>", "Override storage directory")
  .action(async (projectRoot: string, opts: Record<string, unknown>) => {
    const { rm } = await import("node:fs/promises");
    const storageDir = opts.storageDir
      ? resolve(String(opts.storageDir))
      : resolve(projectRoot, ".lucerna");
    try {
      await rm(storageDir, { recursive: true, force: true });
      console.log(`Cleared index at ${storageDir}`);
    } catch (err) {
      console.error(
        `Failed to clear index: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// eval command
// ---------------------------------------------------------------------------

program
  .command("eval <project-root> <queries-file>")
  .description(
    "Measure recall@k against a JSONL file of {query, expectedFile, expectedSymbol?} pairs",
  )
  .option("--storage-dir <dir>", "Override storage directory")
  .option(
    "--k <numbers>",
    "Comma-separated k values to evaluate (e.g. 1,5,10)",
    "1,5,10",
  )
  .option("--format <fmt>", "Output format: raw, json, or pretty-json", "raw")
  .option("--no-semantic", "Disable semantic (vector) search — lexical only")
  .option(
    "--embedder <name>",
    "Built-in embedder: cloudflare, local, bge-small, jina-code",
  )
  .option("--reranker <name>", "Built-in reranker: cloudflare, jina, voyage")
  .option("--config <path>", "Path to lucerna.config.ts / lucerna.config.js")
  .action(
    async (
      projectRoot: string,
      queriesFile: string,
      opts: Record<string, unknown>,
    ) => {
      const { readFile: readFileFs } = await import("node:fs/promises");
      const { resolve: resolvePath } = await import("node:path");

      // Parse k values
      const kValues = String(opts.k ?? "1,5,10")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n > 0)
        .sort((a, b) => a - b);
      if (kValues.length === 0) {
        console.error("Invalid --k values");
        process.exit(1);
      }
      const maxK = kValues[kValues.length - 1] ?? 10;

      // Parse JSONL
      let queries: EvalQuery[];
      try {
        const raw = await readFileFs(resolvePath(queriesFile), "utf8");
        queries = raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line) as EvalQuery);
      } catch (err) {
        console.error(
          `Failed to read queries file: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      if (queries.length === 0) {
        console.error("No queries found in file");
        process.exit(1);
      }

      const indexer = await buildIndexer(projectRoot, {
        ...opts,
        semantic: opts.semantic !== false ? undefined : false,
      });
      try {
        await indexer.initialize();

        // hits[k] = number of queries where expected result appeared in top-k
        const hits = new Map<number, number>(kValues.map((k) => [k, 0]));
        const details: Array<{
          query: string;
          expectedFile: string;
          expectedSymbol?: string;
          hitsAtK: Record<number, boolean>;
        }> = [];

        for (const q of queries) {
          const results = await indexer.search(q.query, { limit: maxK });
          const hitsAtK: Record<number, boolean> = {};
          for (const k of kValues) {
            const topK = results.slice(0, k);
            const hit = topK.some(
              (r) =>
                r.chunk.filePath === q.expectedFile &&
                (q.expectedSymbol === undefined ||
                  r.chunk.name === q.expectedSymbol),
            );
            hitsAtK[k] = hit;
            if (hit) hits.set(k, (hits.get(k) ?? 0) + 1);
          }
          details.push({
            query: q.query,
            expectedFile: q.expectedFile,
            ...(q.expectedSymbol !== undefined
              ? { expectedSymbol: q.expectedSymbol }
              : {}),
            hitsAtK,
          });
        }

        const total = queries.length;
        const recallAtK = Object.fromEntries(
          kValues.map((k) => [
            k,
            Number(((hits.get(k) ?? 0) / total).toFixed(4)),
          ]),
        );

        if (opts.format === "json") {
          console.log(JSON.stringify({ total, recallAtK, details }));
        } else if (opts.format === "pretty-json") {
          console.log(JSON.stringify({ total, recallAtK, details }, null, 2));
        } else {
          console.log(`\nEvaluation results — ${total} queries\n`);
          for (const k of kValues) {
            const pct = ((recallAtK[k] ?? 0) * 100).toFixed(1);
            console.log(
              `  Recall@${k.toString().padEnd(3)}: ${pct}%  (${hits.get(k) ?? 0}/${total})`,
            );
          }
          console.log("\nPer-query breakdown:");
          for (const d of details) {
            const ks = kValues
              .map((k) => `@${k}:${d.hitsAtK[k] ? "✓" : "✗"}`)
              .join("  ");
            const target = d.expectedSymbol
              ? `${d.expectedFile}::${d.expectedSymbol}`
              : d.expectedFile;
            console.log(`  [${ks}]  "${d.query}"  →  ${target}`);
          }
        }
      } finally {
        await indexer.close();
      }
    },
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildIndexer(
  projectRoot: string,
  opts: Record<string, unknown>,
): Promise<CodeIndexer> {
  const resolvedRoot = resolve(projectRoot);

  // Load config file (lucerna.config.ts / .js) — may be overridden by flags below.
  const cfg = await loadConfig(resolvedRoot, opts.config as string | undefined);

  // Resolve embedding function. Priority: --no-semantic > --embedder flag > config file.
  let embeddingFunction: EmbeddingFunction | false | undefined =
    cfg.embeddingFunction;
  if (opts.semantic === false) {
    embeddingFunction = false;
  } else if (opts.embedder) {
    embeddingFunction = await resolveBuiltinEmbedder(String(opts.embedder));
  }

  // Resolve reranking function. Priority: --reranker flag > config file.
  let rerankingFunction: RerankingFunction | false | undefined =
    cfg.rerankingFunction;
  if (opts.reranker) {
    rerankingFunction = await resolveBuiltinReranker(String(opts.reranker));
  }

  return new CodeIndexer({
    projectRoot: resolvedRoot,
    ...(opts.storageDir
      ? { storageDir: resolve(String(opts.storageDir)) }
      : {}),
    ...(opts.include
      ? {
          include: String(opts.include)
            .split(",")
            .map((s) => s.trim()),
        }
      : {}),
    ...(opts.exclude
      ? {
          exclude: String(opts.exclude)
            .split(",")
            .map((s) => s.trim()),
        }
      : {}),
    ...(embeddingFunction !== undefined ? { embeddingFunction } : {}),
    ...(rerankingFunction !== undefined ? { rerankingFunction } : {}),
    ...(opts.watchDebounce !== undefined
      ? { watchDebounce: opts.watchDebounce as number }
      : {}),
    ...(opts.watch !== undefined ? { watch: opts.watch as boolean } : {}),
    ...(opts.onIndexed !== undefined
      ? { onIndexed: opts.onIndexed as (event: IndexEvent) => void }
      : {}),
  });
}

function printList(results: SearchResult[]): void {
  for (const r of results) {
    const header = `${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}  [${r.chunk.type}]${r.chunk.name ? ` ${r.chunk.name}` : ""}`;
    const ctx = Object.entries(r.chunk.metadata)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(ctx ? `${header}  ${ctx}` : header);
    const snippet = r.chunk.content.slice(0, 200).trim();
    const truncated = r.chunk.content.length > 200;
    console.log(`  ${snippet}${truncated ? "\n  ..." : ""}`);
    console.log();
  }
  console.log(`${results.length} result(s)`);
}

function chunkToJson(chunk: CodeChunk): Record<string, unknown> {
  const hasContext = Object.keys(chunk.metadata).length > 0;
  return {
    id: chunk.id,
    file: `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
    type: chunk.type,
    ...(chunk.name ? { name: chunk.name } : {}),
    ...(hasContext ? { context: chunk.metadata } : {}),
    content: chunk.content,
  };
}

function printChunks(chunks: CodeChunk[], labels?: string[]): void {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const label = labels?.[i] ? `  (${labels[i]})` : "";
    const header = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}  [${chunk.type}]${chunk.name ? ` ${chunk.name}` : ""}${label}`;
    console.log(header);
    const snippet = chunk.content.slice(0, 200).trim();
    const truncated = chunk.content.length > 200;
    console.log(`  ${snippet}${truncated ? "\n  ..." : ""}`);
    console.log();
  }
  console.log(`${chunks.length} result(s)`);
}

// ---------------------------------------------------------------------------
// mcp-server command
// ---------------------------------------------------------------------------

program
  .command("mcp-server [project-root]")
  .description(
    "Start an MCP stdio server for the project — indexes on start, watches for changes",
  )
  .option("--storage-dir <dir>", "Override storage directory")
  .option("--no-semantic", "Disable semantic/vector search (lexical only)")
  .option(
    "--embedder <name>",
    "Built-in embedder: cloudflare, local, bge-small, jina-code",
  )
  .option("--reranker <name>", "Built-in reranker: cloudflare, jina, voyage")
  .option("--config <path>", "Path to lucerna.config.ts / lucerna.config.js")
  .action(async (projectRoot = ".", opts: Record<string, unknown>) => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer(resolve(projectRoot), {
      ...(opts.storageDir
        ? { storageDir: resolve(String(opts.storageDir)) }
        : {}),
      ...(opts.semantic === false ? { semantic: false } : {}),
      ...(opts.embedder ? { embedder: String(opts.embedder) } : {}),
      ...(opts.reranker ? { reranker: String(opts.reranker) } : {}),
      ...(opts.config ? { config: String(opts.config) } : {}),
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
