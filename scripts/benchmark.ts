/**
 * Benchmark script for lucerna.
 *
 * Measures indexing throughput, search latency, and graph traversal performance.
 * Results are printed to stdout and appended to benchmark-results.jsonl
 * so you can track performance over time.
 *
 * Usage:
 *   bun scripts/benchmark.ts [project-root]
 *
 * Options (env vars):
 *   BENCH_PROJECT        path to the project to index (default: this repo)
 *   BENCH_SEMANTIC       set to "0" to skip semantic search (avoids model download; enabled by default)
 *   BENCH_RUNS           number of search iterations per query (default: 10)
 *   BENCH_GRAPH_DEPTH    graph traversal depth for neighbourhood bench (default: 1)
 *   BENCH_OUTPUT         path to append results JSON (default: benchmark-results.jsonl)
 */
import { existsSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { CodeIndexer, CloudflareReranker } from "../src/index.js";
import { resolveEmbedderFromEnv } from "../src/config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dirname, "..");

const mainEmbeddingFn =
  process.env.BENCH_SEMANTIC === "0" ? false : await resolveEmbedderFromEnv();
const SEMANTIC_ENABLED = mainEmbeddingFn !== false;
const RERANK_ENABLED =
  SEMANTIC_ENABLED &&
  !!process.env.CLOUDFLARE_ACCOUNT_ID &&
  !!process.env.CLOUDFLARE_API_TOKEN;
const SEARCH_RUNS = parseInt(process.env.BENCH_RUNS ?? "10", 10);
const GRAPH_DEPTH = parseInt(process.env.BENCH_GRAPH_DEPTH ?? "1", 10);
const OUTPUT_FILE =
  process.env.BENCH_OUTPUT ??
  resolve(import.meta.dirname, "..", "benchmark-results.jsonl");

const STORAGE_DIR = resolve(import.meta.dirname, "..", ".bench-index");

const SEARCH_QUERIES = [
  "initialize parser and load grammar",
  "search results ranking",
  "file watcher debounce",
  "embedding function interface",
  "vector store upsert",
  "chunk type function class method",
  "TypeScript AST extraction",
  "hybrid search reciprocal rank fusion",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(label: string) {
  const line = "─".repeat(Math.max(0, 60 - label.length - 2));
  console.log(`\n┌─ ${label} ${line}`);
}

function row(label: string, value: string, note = "") {
  const pad = 34;
  console.log(`│  ${label.padEnd(pad)}${value}${note ? `  ${dim(note)}` : ""}`);
}

function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}

function bold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}

function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${(ms * 1000).toFixed(0)} µs`;
}

function formatThroughput(count: number, ms: number): string {
  const perSec = (count / ms) * 1000;
  return perSec >= 1000
    ? `${(perSec / 1000).toFixed(1)}k/s`
    : `${perSec.toFixed(0)}/s`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Run fn once and return elapsed ms. */
async function time<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

/** Run fn N times, return stats over the timings. */
async function bench(
  fn: () => Promise<unknown>,
  runs: number,
): Promise<{
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}> {
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const p = (pct: number) =>
    timings[Math.floor((pct / 100) * timings.length)] ??
    timings[timings.length - 1] ??
    0;
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
  return {
    mean,
    p50: p(50),
    p95: p(95),
    p99: p(99),
    min: timings[0] ?? 0,
    max: timings[timings.length - 1] ?? 0,
  };
}

const p = (arr: number[], pct: number) =>
  arr[Math.floor((pct / 100) * arr.length)] ?? arr[arr.length - 1] ?? 0;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(bold("\n  lucerna benchmark"));
  console.log(dim(`  ${new Date().toISOString()}`));
  console.log(dim(`  project : ${PROJECT_ROOT}`));
  console.log(
    dim(
      `  semantic: ${SEMANTIC_ENABLED ? "enabled" : "disabled (LUCERNA_EMBEDDING not set)"}`,
    ),
  );
  console.log(dim(`  runs    : ${SEARCH_RUNS} per query`));
  console.log(dim(`  graph depth: ${GRAPH_DEPTH}`));

  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    project: PROJECT_ROOT,
    semanticEnabled: SEMANTIC_ENABLED,
    searchRuns: SEARCH_RUNS,
    graphDepth: GRAPH_DEPTH,
    nodeVersion: process.version,
    platform: process.platform,
  };

  // ── 1. Setup ────────────────────────────────────────────────────────────

  hr("Setup");

  // Clear any previous bench index so we always cold-start
  if (existsSync(STORAGE_DIR)) {
    const { rm } = await import("node:fs/promises");
    await rm(STORAGE_DIR, { recursive: true, force: true });
  }

  const indexer = new CodeIndexer({
    projectRoot: PROJECT_ROOT,
    storageDir: STORAGE_DIR,
    embeddingFunction: mainEmbeddingFn,
    // Exclude the bench storage dir and test fixtures
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.env",
      "**/.claude/**",
      "**/dist/**",
      "**/.bench-index/**",
      "**/.bench-index-coderank/**",
      "**/.bench-index-jina/**",
      "**/.bench-index-nomic/**",
      "**/.bench-index-gemma/**",
      "**/.lucerna/**",
      "**/benchmark-results.jsonl",
    ],
  });

  // ── 2. Initialize ───────────────────────────────────────────────────────

  hr("Initialize");

  const { ms: initMs } = await time(() => indexer.initialize());
  row(
    "initialize()",
    green(formatMs(initMs)),
    "load grammars + open DB + graph store",
  );
  results.initMs = initMs;

  // ── 3. Cold index ───────────────────────────────────────────────────────

  hr("Indexing — cold (first run)");

  const { result: coldStats, ms: coldMs } = await time(() =>
    indexer.indexProject(),
  );
  const { totalFiles, totalChunks, totalEdges, byEdgeType } = coldStats;

  row("indexProject() — total time", green(formatMs(coldMs)));
  row("files indexed", formatCount(totalFiles));
  row("chunks produced", formatCount(totalChunks));
  row("throughput — files", formatThroughput(totalFiles, coldMs));
  row("throughput — chunks", formatThroughput(totalChunks, coldMs));
  row("avg time / file", formatMs(coldMs / totalFiles));
  row("avg chunks / file", (totalChunks / totalFiles).toFixed(1));

  results.coldIndexMs = coldMs;
  results.totalFiles = totalFiles;
  results.totalChunks = totalChunks;

  // ── 4. Warm re-index ────────────────────────────────────────────────────

  hr("Indexing — warm (re-index same project)");

  const { ms: warmMs } = await time(() => indexer.indexProject());
  const speedup = coldMs / warmMs;

  row("indexProject() — total time", green(formatMs(warmMs)));
  row("speedup vs cold", `${speedup.toFixed(1)}×`);
  row("throughput — files", formatThroughput(totalFiles, warmMs));
  row("throughput — chunks", formatThroughput(totalChunks, warmMs));

  results.warmIndexMs = warmMs;

  // ── 5. Single file re-index ─────────────────────────────────────────────

  hr("Indexing — single file");

  // Pick a moderately large source file
  const sampleFile = "src/CodeIndexer.ts";
  const samplePath = resolve(PROJECT_ROOT, sampleFile);
  const singleFileExists = existsSync(samplePath);

  if (singleFileExists) {
    const fileStat = await stat(samplePath);
    const singleBench = await bench(
      () => indexer.indexFile(sampleFile),
      Math.min(SEARCH_RUNS, 10),
    );

    row("indexFile() target", sampleFile);
    row("file size", `${(fileStat.size / 1024).toFixed(1)} KB`);
    row("mean", green(formatMs(singleBench.mean)));
    row("p50", formatMs(singleBench.p50));
    row("p95", formatMs(singleBench.p95));
    row("p99", formatMs(singleBench.p99));

    results.singleFileIndexMs = singleBench;
  } else {
    row("skipped", dim("src/CodeIndexer.ts not found"));
  }

  // ── 6. Graph — edge statistics ──────────────────────────────────────────

  hr("Graph — edge statistics");

  row("total edges", green(formatCount(totalEdges)));
  row(
    "edges per chunk (avg)",
    totalChunks > 0 ? (totalEdges / totalChunks).toFixed(2) : "0",
  );

  const edgeTypeOrder: Array<keyof typeof byEdgeType> = [
    "IMPORTS",
    "DEFINES",
    "CALLS",
    "EXTENDS",
    "IMPLEMENTS",
    "USES",
  ];
  for (const type of edgeTypeOrder) {
    const count = byEdgeType[type];
    if (count !== undefined && count > 0) {
      row(`  ${type}`, formatCount(count));
    }
  }

  results.totalEdges = totalEdges;
  results.edgesByType = byEdgeType;

  // ── 7. Graph — neighbourhood traversal latency ──────────────────────────

  hr(`Graph — getNeighborhood() — depth=${GRAPH_DEPTH}`);

  // Collect seed chunk IDs: grab the first chunk from several source files
  const allFiles = await indexer.listFiles();
  const seedChunkIds: string[] = [];
  const tsFiles = allFiles
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .slice(0, 8);

  for (const f of tsFiles) {
    const chunks = await indexer.getChunks(f);
    const fn = chunks.find((c) => c.type === "function" || c.type === "method");
    if (fn) seedChunkIds.push(fn.id);
  }

  if (seedChunkIds.length > 0) {
    let seedIdx = 0;
    const graphBench = await bench(
      () =>
        indexer.getNeighborhood(
          seedChunkIds[seedIdx++ % seedChunkIds.length] ?? "",
          { depth: GRAPH_DEPTH },
        ),
      SEARCH_RUNS,
    );

    row(`seeds used`, String(seedChunkIds.length));
    row("mean", green(formatMs(graphBench.mean)));
    row("p50", formatMs(graphBench.p50));
    row("p95", formatMs(graphBench.p95));
    row("p99", formatMs(graphBench.p99));

    results.graphNeighbourhoodMs = graphBench;
  } else {
    row("skipped", dim("no function/method chunks found for seeding"));
  }

  // ── 8. Lexical search ───────────────────────────────────────────────────

  hr(
    `Lexical search (BM25) — ${SEARCH_RUNS} runs × ${SEARCH_QUERIES.length} queries`,
  );

  const lexicalTimings: number[] = [];
  for (const query of SEARCH_QUERIES) {
    const stats = await bench(
      () => indexer.searchLexical(query, { limit: 10 }),
      SEARCH_RUNS,
    );
    lexicalTimings.push(stats.mean);
  }
  lexicalTimings.sort((a, b) => a - b);
  const lexMean =
    lexicalTimings.reduce((a, b) => a + b, 0) / lexicalTimings.length;

  row("mean (across queries)", green(formatMs(lexMean)));
  row("p50", formatMs(p(lexicalTimings, 50)));
  row("p95", formatMs(p(lexicalTimings, 95)));
  row("min query", formatMs(lexicalTimings[0] ?? 0));
  row("max query", formatMs(lexicalTimings[lexicalTimings.length - 1] ?? 0));

  results.lexicalSearchMs = {
    mean: lexMean,
    p50: p(lexicalTimings, 50),
    p95: p(lexicalTimings, 95),
    min: lexicalTimings[0],
    max: lexicalTimings[lexicalTimings.length - 1],
  };

  // ── 9. Semantic + hybrid search ─────────────────────────────────────────

  let semMean = 0;

  if (SEMANTIC_ENABLED) {
    hr(
      `Semantic search (vector) — ${SEARCH_RUNS} runs × ${SEARCH_QUERIES.length} queries`,
    );
    console.log(dim("│  (first query will trigger model load)"));

    const semanticTimings: number[] = [];
    let firstRun = true;
    for (const query of SEARCH_QUERIES) {
      const stats = await bench(async () => {
        await indexer.searchSemantic(query, { limit: 10 });
      }, SEARCH_RUNS);
      if (!firstRun) semanticTimings.push(stats.mean);
      firstRun = false; // discard first query — model cold start
    }
    semanticTimings.sort((a, b) => a - b);
    semMean =
      semanticTimings.reduce((a, b) => a + b, 0) / semanticTimings.length;

    row("mean (across queries, excl. cold start)", green(formatMs(semMean)));
    row("p50", formatMs(p(semanticTimings, 50)));
    row("p95", formatMs(p(semanticTimings, 95)));
    row("min query", formatMs(semanticTimings[0] ?? 0));
    row(
      "max query",
      formatMs(semanticTimings[semanticTimings.length - 1] ?? 0),
    );

    results.semanticSearchMs = {
      mean: semMean,
      p50: p(semanticTimings, 50),
      p95: p(semanticTimings, 95),
      min: semanticTimings[0],
      max: semanticTimings[semanticTimings.length - 1],
    };

    // ── 10. Hybrid search ────────────────────────────────────────────────

    hr(
      `Hybrid search (BM25 + vector, RRF) — ${SEARCH_RUNS} runs × ${SEARCH_QUERIES.length} queries`,
    );

    const hybridTimings: number[] = [];
    for (const query of SEARCH_QUERIES) {
      const stats = await bench(
        () => indexer.search(query, { limit: 10, hybrid: true }),
        SEARCH_RUNS,
      );
      hybridTimings.push(stats.mean);
    }
    hybridTimings.sort((a, b) => a - b);
    const hybMean =
      hybridTimings.reduce((a, b) => a + b, 0) / hybridTimings.length;

    row("mean (across queries)", green(formatMs(hybMean)));
    row("p50", formatMs(p(hybridTimings, 50)));
    row("p95", formatMs(p(hybridTimings, 95)));
    row(
      "overhead vs semantic alone",
      `+${((hybMean / semMean - 1) * 100).toFixed(0)}%`,
    );

    results.hybridSearchMs = {
      mean: hybMean,
      p50: p(hybridTimings, 50),
      p95: p(hybridTimings, 95),
      min: hybridTimings[0],
      max: hybridTimings[hybridTimings.length - 1],
    };

    // ── 10b. Reranking overhead ──────────────────────────────────────────

    if (RERANK_ENABLED) {
      // Each reranker search requires two Cloudflare round-trips (embed + rerank).
      // Use at most 3 runs per query so the benchmark finishes in reasonable time.
      const RERANK_RUNS = Math.min(3, SEARCH_RUNS);

      hr(
        `Reranking overhead (BM25 + vector + reranker) — ${RERANK_RUNS} runs × ${SEARCH_QUERIES.length} queries`,
      );
      console.log(
        dim("│  (first query discarded — reranker connection warm-up)"),
      );

      const rerankIndexer = new CodeIndexer({
        projectRoot: PROJECT_ROOT,
        storageDir: STORAGE_DIR,
        rerankingFunction: new CloudflareReranker(),
        exclude: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/.bench-index/**",
          "**/benchmark-results.jsonl",
        ],
      });
      await rerankIndexer.initialize();

      // Discard first query — reranker connection warm-up
      await rerankIndexer.search(SEARCH_QUERIES[0] ?? "", { limit: 10 });

      const rerankTimings: number[] = [];
      let rerankFirst = true;
      for (const query of SEARCH_QUERIES) {
        const stats = await bench(
          () => rerankIndexer.search(query, { limit: 10 }),
          RERANK_RUNS,
        );
        if (!rerankFirst) rerankTimings.push(stats.mean);
        rerankFirst = false;
      }
      await rerankIndexer.close();

      rerankTimings.sort((a, b) => a - b);
      const rerankMean =
        rerankTimings.reduce((a, b) => a + b, 0) / rerankTimings.length;
      const rerankOverhead = ((rerankMean / hybMean - 1) * 100).toFixed(0);

      row(
        "mean (across queries, excl. cold start)",
        green(formatMs(rerankMean)),
      );
      row("p50", formatMs(p(rerankTimings, 50)));
      row("p95", formatMs(p(rerankTimings, 95)));
      row(
        "overhead vs hybrid",
        `+${rerankOverhead}%`,
        `${formatMs(hybMean)} → ${formatMs(rerankMean)}`,
      );

      results.rerankSearchMs = {
        mean: rerankMean,
        p50: p(rerankTimings, 50),
        p95: p(rerankTimings, 95),
        overheadVsHybridPct: Number(rerankOverhead),
      };
    } else {
      console.log(
        dim(
          "\n│  Reranking benchmark skipped (set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN to enable)",
        ),
      );
    }

    // ── 11. searchWithContext overhead ───────────────────────────────────

    hr(`searchWithContext() overhead — graphDepth=${GRAPH_DEPTH}`);

    const searchTimings: number[] = [];
    const contextTimings: number[] = [];
    let totalNeighboursAdded = 0;
    let contextQueryCount = 0;

    for (const query of SEARCH_QUERIES) {
      const baseStat = await bench(
        () => indexer.search(query, { limit: 10 }),
        SEARCH_RUNS,
      );
      searchTimings.push(baseStat.mean);

      const baseResults = await indexer.search(query, { limit: 10 });
      const contextResults = await indexer.searchWithContext(query, {
        limit: 10,
        graphDepth: GRAPH_DEPTH,
      });
      totalNeighboursAdded += Math.max(
        0,
        contextResults.length - baseResults.length,
      );
      contextQueryCount++;

      const contextStat = await bench(
        () =>
          indexer.searchWithContext(query, {
            limit: 10,
            graphDepth: GRAPH_DEPTH,
          }),
        SEARCH_RUNS,
      );
      contextTimings.push(contextStat.mean);
    }

    searchTimings.sort((a, b) => a - b);
    contextTimings.sort((a, b) => a - b);
    const searchMean =
      searchTimings.reduce((a, b) => a + b, 0) / searchTimings.length;
    const contextMean =
      contextTimings.reduce((a, b) => a + b, 0) / contextTimings.length;
    const overheadPct = ((contextMean / searchMean - 1) * 100).toFixed(0);
    const avgNeighboursAdded = (
      totalNeighboursAdded / contextQueryCount
    ).toFixed(1);

    row("search() mean (baseline)", formatMs(searchMean));
    row("searchWithContext() mean", green(formatMs(contextMean)));
    row("graph expansion overhead", `+${overheadPct}%`);
    row("avg neighbour chunks added", avgNeighboursAdded);

    results.searchWithContextMs = {
      searchMean,
      contextMean,
      overheadPct: Number(overheadPct),
      avgNeighboursAdded: Number(avgNeighboursAdded),
    };
  } else {
    console.log(
      dim(
        "\n│  Semantic + hybrid + searchWithContext skipped (set LUCERNA_EMBEDDING to enable, e.g. LUCERNA_EMBEDDING=openai:text-embedding-3-small)",
      ),
    );
  }

  // ── 12. Close indexer ───────────────────────────────────────────────────

  await indexer.close();

  // ── 13. Summary ─────────────────────────────────────────────────────────

  hr("Summary");

  row("initialize", formatMs(initMs));
  row(
    "cold index",
    `${formatMs(coldMs)}  (${formatCount(totalFiles)} files, ${formatCount(totalChunks)} chunks)`,
  );
  row("warm re-index", formatMs(warmMs));
  row("total graph edges", formatCount(totalEdges));
  row(
    "graph neighbourhood (mean)",
    seedChunkIds.length > 0
      ? formatMs((results.graphNeighbourhoodMs as { mean: number }).mean)
      : dim("skipped"),
  );
  row("lexical search (mean)", formatMs(lexMean));
  if (results.semanticSearchMs) {
    const s = results.semanticSearchMs as { mean: number };
    row("semantic search (mean)", formatMs(s.mean));
  }
  if (results.hybridSearchMs) {
    const h = results.hybridSearchMs as { mean: number };
    row("hybrid search (mean)", formatMs(h.mean));
  }
  if (results.rerankSearchMs) {
    const r = results.rerankSearchMs as {
      mean: number;
      overheadVsHybridPct: number;
    };
    row(
      "reranking search (mean)",
      `${formatMs(r.mean)}  ${yellow(`+${r.overheadVsHybridPct}% vs hybrid`)}`,
    );
  }
  if (results.searchWithContextMs) {
    const sc = results.searchWithContextMs as {
      contextMean: number;
      overheadPct: number;
    };
    row(
      "searchWithContext (mean)",
      `${formatMs(sc.contextMean)}  ${yellow(`+${sc.overheadPct}% vs search`)}`,
    );
  }

  console.log(`\n└${"─".repeat(61)}`);

  // ── 13. Persist results ──────────────────────────────────────────────────

  await appendFile(OUTPUT_FILE, `${JSON.stringify(results)}\n`, "utf8");
  console.log(
    dim(`\n  Results appended to ${relative(process.cwd(), OUTPUT_FILE)}`),
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────

  // Remove the bench storage dir so it doesn't pollute the repo
  if (existsSync(STORAGE_DIR)) {
    const { rm } = await import("node:fs/promises");
    await rm(STORAGE_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(
    "\n  Benchmark failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
