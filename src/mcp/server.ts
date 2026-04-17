#!/usr/bin/env node
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodeIndexer } from "../CodeIndexer.js";
import type { SearchOptions, SearchWithContextOptions } from "../types.js";
import pkg from "../../package.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[lucerna] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startMcpServer(
  projectRoot: string,
  opts: { storageDir?: string; semantic?: boolean } = {},
): Promise<void> {
  const resolvedRoot = resolve(projectRoot);

  const indexer = new CodeIndexer({
    projectRoot: resolvedRoot,
    ...(opts.storageDir !== undefined ? { storageDir: opts.storageDir } : {}),
    ...(opts.semantic === false ? { embeddingFunction: false } : {}),
    onIndexed: (event) => {
      if (event.type === "indexed") {
        log(`indexed ${event.filePath} (${event.chunksAffected ?? 0} chunks)`);
      } else if (event.type === "removed") {
        log(`removed ${event.filePath}`);
      } else if (event.type === "error") {
        log(`error ${event.filePath}: ${event.error?.message}`);
      }
    },
  });

  await indexer.initialize();
  log(`Project root: ${resolvedRoot}`);

  // Track whether the initial index has completed so we can warn callers that
  // results may be empty during first-time indexing.
  let indexingComplete = false;

  const indexingPromise = indexer
    .indexProject()
    .then(async (stats) => {
      indexingComplete = true;
      log(
        `Initial index complete: ${stats.totalFiles} files, ${stats.totalChunks} chunks.`,
      );
      await indexer.startWatching();
      log("Watching for file changes.");
    })
    .catch((err: Error) => {
      log(`Indexing error: ${err.message}`);
    });

  // Keep a reference so the promise isn't GC'd before it resolves.
  void indexingPromise;

  // -------------------------------------------------------------------------
  // MCP server setup
  // -------------------------------------------------------------------------

  const server = new McpServer({
    name: "lucerna",
    version: pkg.version,
  });

  // -------------------------------------------------------------------------
  // Tool: search_codebase
  // -------------------------------------------------------------------------

  server.tool(
    "search_codebase",
    "Search the codebase using hybrid semantic + lexical (BM25) search. " +
      "Optionally expands results with graph context (callers, callees, imports). " +
      "Returns an empty array with a warning message while the project is being indexed for the first time.",
    {
      query: z.string().describe("The search query"),
      includeGraphContext: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Expand results with related symbols from the knowledge graph (default: true)",
        ),
      graphDepth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .default(1)
        .describe("How many graph hops to follow when expanding context (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of results to return (default: 10)"),
      language: z
        .string()
        .optional()
        .describe(
          "Restrict results to a specific language (e.g. 'typescript', 'python')",
        ),
      type: z
        .enum([
          "function",
          "class",
          "method",
          "interface",
          "type",
          "variable",
          "import",
          "section",
          "file",
        ])
        .optional()
        .describe("Restrict results to a specific chunk type"),
      filePath: z
        .string()
        .optional()
        .describe("Filter results by file path (supports glob patterns)"),
    },
    async ({
      query,
      includeGraphContext,
      graphDepth,
      limit,
      language,
      type,
      filePath,
    }) => {
      const warning =
        !indexingComplete
          ? "Lucerna is still indexing this project for the first time. Results may be incomplete — please retry in a few seconds."
          : undefined;

      const baseOpts: SearchOptions = {
        limit,
        ...(language !== undefined ? { language } : {}),
        ...(type !== undefined ? { types: [type] } : {}),
        ...(filePath !== undefined ? { filePath } : {}),
      };

      let results;
      if (includeGraphContext) {
        const ctxOpts: SearchWithContextOptions = {
          ...baseOpts,
          graphDepth: graphDepth ?? 1,
        };
        results = await indexer.searchWithContext(query, ctxOpts);
      } else {
        results = await indexer.search(query, baseOpts);
      }

      const payload: {
        results: typeof results;
        warning?: string;
      } = { results };
      if (warning !== undefined) {
        payload.warning = warning;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_neighbors
  // -------------------------------------------------------------------------

  server.tool(
    "get_neighbors",
    "Get the knowledge-graph neighborhood of a chunk returned by search_codebase. " +
      "Returns related symbols (callers, callees, imports, etc.) up to the given depth.",
    {
      chunkId: z
        .string()
        .describe(
          "The chunk ID from a search_codebase result (chunk.id field)",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .default(1)
        .describe("How many hops to traverse (default: 1)"),
    },
    async ({ chunkId, depth }) => {
      const neighborhood = await indexer.getNeighborhood(chunkId, {
        depth: depth ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(neighborhood, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Connect via stdio and keep running
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready (stdio).");

  // Keep the process alive until the transport closes.
  await new Promise<void>((resolvePromise) => {
    server.server.onclose = () => resolvePromise();
    process.once("SIGINT", async () => {
      await indexer.close();
      resolvePromise();
    });
    process.once("SIGTERM", async () => {
      await indexer.close();
      resolvePromise();
    });
  });

  await indexer.close();
}

// ---------------------------------------------------------------------------
// Standalone binary entry point
// ---------------------------------------------------------------------------

// This file is used both as an imported module (from CLI) and as a standalone
// binary (lucerna-mcp). When run directly, parse argv and start.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/mcp.mjs") ||
    process.argv[1].endsWith("/server.ts") ||
    process.argv[1].includes("lucerna-mcp"));

if (isMain) {
  const projectRoot = process.argv[2] ?? process.cwd();
  startMcpServer(projectRoot).catch((err: Error) => {
    process.stderr.write(`[lucerna] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
