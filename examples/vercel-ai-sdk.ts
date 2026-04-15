// @ts-nocheck
/**
 * Example: Wrapping lucerna in the Vercel AI SDK
 *
 * This shows how to expose a CodeIndexer as a set of AI tool calls
 * that an agent can use to search a codebase.
 *
 * Install the additional deps for this example:
 *   pnpm add ai zod
 *
 * Usage:
 *   import { searchCodeTool, getChunksTool } from './examples/vercel-ai-sdk';
 *   // Pass these tools to generateText / streamText
 */

import { tool } from "ai";
import { z } from "zod";
import { CodeIndexer } from "../src/index.js";

// ---------------------------------------------------------------------------
// Shared indexer (singleton for this example)
// ---------------------------------------------------------------------------

const indexer = new CodeIndexer({
  projectRoot: process.cwd(),
  // Uses @huggingface/transformers (all-MiniLM-L6-v2) by default.
  // Set embeddingFunction: false for lexical-only search without a model.
});

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await indexer.initialize();
    await indexer.indexProject();
    initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Tool: search_code
// ---------------------------------------------------------------------------

/**
 * Search the codebase using hybrid (semantic + lexical) search.
 * Returns the most relevant code chunks for the given query.
 */
export const searchCodeTool = tool({
  description:
    "Search the codebase for relevant functions, classes, methods, or documentation. " +
    "Use natural language or symbol names. Returns code snippets with file locations.",
  parameters: z.object({
    query: z
      .string()
      .describe("Natural language description or symbol name to search for"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results to return"),
    language: z
      .enum(["typescript", "javascript", "json", "markdown"])
      .optional()
      .describe("Filter results to a specific language"),
    type: z
      .enum([
        "function",
        "class",
        "method",
        "interface",
        "type",
        "section",
        "file",
      ])
      .optional()
      .describe("Filter by chunk type"),
  }),
  execute: async ({ query, limit, language, type }) => {
    await ensureInitialized();
    const results = await indexer.search(query, {
      limit,
      language,
      types: type ? [type] : undefined,
    });

    return results.map((r) => ({
      file: r.chunk.filePath,
      language: r.chunk.language,
      type: r.chunk.type,
      name: r.chunk.name ?? null,
      lines: `${r.chunk.startLine}–${r.chunk.endLine}`,
      score: Math.round(r.score * 1000) / 1000,
      matchType: r.matchType,
      content: r.chunk.content,
    }));
  },
});

// ---------------------------------------------------------------------------
// Tool: get_file_chunks
// ---------------------------------------------------------------------------

/**
 * Retrieve all indexed chunks for a specific file.
 * Useful for getting a structured overview of a file's symbols.
 */
export const getFileChunksTool = tool({
  description:
    "Get all indexed code chunks (symbols) for a specific file. " +
    "Returns a structured list of functions, classes, interfaces, etc.",
  parameters: z.object({
    filePath: z
      .string()
      .describe("Path to the file, relative to the project root"),
  }),
  execute: async ({ filePath }) => {
    await ensureInitialized();
    const chunks = await indexer.getChunks(filePath);
    return chunks.map((c) => ({
      type: c.type,
      name: c.name ?? null,
      lines: `${c.startLine}–${c.endLine}`,
      content: c.content,
    }));
  },
});

// ---------------------------------------------------------------------------
// Tool: index_stats
// ---------------------------------------------------------------------------

/**
 * Get statistics about the current code index.
 */
export const indexStatsTool = tool({
  description:
    "Get statistics about the indexed codebase (file count, chunk count, etc.)",
  parameters: z.object({}),
  execute: async () => {
    await ensureInitialized();
    const stats = await indexer.getStats();
    return {
      projectId: stats.projectId,
      totalFiles: stats.totalFiles,
      totalChunks: stats.totalChunks,
      lastIndexed: stats.lastIndexed?.toISOString() ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Usage example
// ---------------------------------------------------------------------------

// import { generateText } from 'ai';
// import { openai } from '@ai-sdk/openai'; // or any other provider
//
// const { text } = await generateText({
//   model: openai('gpt-4o'),
//   tools: { searchCodeTool, getFileChunksTool, indexStatsTool },
//   maxSteps: 5,
//   prompt: 'Find all authentication-related functions in the codebase.',
// });
//
// console.log(text);

// ---------------------------------------------------------------------------
// Cleanup on exit (optional, for long-running processes)
// ---------------------------------------------------------------------------

process.on("exit", () => {
  indexer.close().catch(() => {});
});
