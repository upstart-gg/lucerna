# lucerna — Developer & Agent Guide

> **For AI coding assistants.** This file explains what lucerna does, how the codebase is structured, and what conventions to follow when making changes. Read this before editing anything.

---

## What it is

lucerna is an **AST-aware semantic + lexical code indexer** designed as middleware for AI coding agents. It combines:

- **Vector search** (HuggingFace Transformers embeddings, via `@huggingface/transformers`)
- **BM25 full-text search** (code-aware tokenization — identifiers split on camelCase/underscores)
- **Knowledge graph** (symbol relationships: calls, implements, extends, uses, imports)

All three are stored in a single embedded [LanceDB](https://lancedb.github.io/lancedb/) database at `<project-root>/.lucerna/`. There are no external services, no servers, no configuration files — just the library or CLI.

Parsing is done by [tree-sitter](https://tree-sitter.github.io/) via `@kreuzberg/tree-sitter-language-pack`, which supports 305 languages. All 305 languages are indexed automatically — no configuration needed. `.gitignore` files at any depth are always respected.

---

## Key commands

```bash
bun test                # Run unit tests
bun run typecheck       # TypeScript type-check (tsgo --noEmit)
bun run lint            # Biome lint + format (writes fixes)
bun run ci:lint         # Biome lint (read-only, for CI)
bun run build           # Build dist/ with tsdown
bun run test:dist       # Build + smoke test the bundled CLI
bun run test:integration  # Integration tests (requires INTEGRATION_TESTS=1)
```

During development, run the CLI directly without building:
```bash
bun run dev index /path/to/project
bun run dev search /path/to/project "my query"
```

---

## Source layout

```
src/
  CodeIndexer.ts          # Main public API class — orchestrates everything
  types.ts                # All shared types and interfaces (CodeChunk, SearchResult, etc.)
  chunker/
    TreeSitterChunker.ts  # AST → chunks via tree-sitter; also builds raw graph edges
  graph/
    types.ts              # Graph types + canonical hashEdgeId()
    SymbolResolver.ts     # Resolves cross-file import edges; handles tsconfig paths + extends
  store/
    LanceDBStore.ts       # Chunk storage, vector + BM25 search, filter builder
    GraphStore.ts         # Knowledge graph (LanceDB table); edge upsert + traversal
  embeddings/
    NomicCodeEmbeddings.ts  # Default embedding model (nomic-embed-code)
    HFEmbeddings.ts         # Generic HuggingFace embeddings wrapper
    JinaReranker.ts         # Optional Jina reranker
    VoyageReranker.ts       # Optional Voyage AI reranker
  cli/
    index.ts              # CLI entry point (Commander); commands: index, watch, search, graph, stats, eval, clear
  tests/
    *.test.ts             # Unit tests (Bun test runner)
    cli.dist.test.ts      # Distribution smoke tests
```

---

## Architecture

### Data flow (indexing)

```
Files on disk
  → TreeSitterChunker.chunkFileWithEdges()
      → tree-sitter parse → AST walk → CodeChunk[]
      → SymbolResolver.resolve()  →  raw graph edges (import/call/etc.)
  → CodeIndexer.normalizeResult()   (abs paths → rel paths, stable IDs)
  → LanceDBStore.upsertChunks()     (vector embed + BM25 index)
  → GraphStore.upsertEdges()        (knowledge graph edges)
  → fileHashes persisted to .lucerna/hashes.json
```

### Data flow (search)

```
query string
  → LanceDBStore.search()
      → vector search (ANN) + BM25 text search (via LanceDB/DataFusion)
      → Reciprocal Rank Fusion (k=45) to merge rankings
      → optional filter by language / type
  → optional reranker (JinaReranker / VoyageReranker)
  → SearchResult[]
```

### In-memory chunk cache

`CodeIndexer` maintains `cachedChunksByFile: Map<string, CodeChunk[]>`. This cache is populated on first `loadAllChunks()` call (either during `indexProject` or lazily on first watch event). During watch mode, the cache is updated incrementally per file — no full DB scan on each save event.

---

## Key design decisions

### SQL escaping in LanceDB filters

LanceDB uses DataFusion SQL internally. **All user-supplied values must be escaped with `sqlStr()`** before being interpolated into filter strings:

```typescript
function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;  // standard SQL quoting
}
```

Do **not** use MySQL-style backslash escaping (`\'`). This function exists in both `LanceDBStore.ts` and `GraphStore.ts`. Any new filter conditions must use it.

### Parallel async operations

`indexProject()` parallelizes file hashing (`Promise.all`) and chunking (`Promise.all`). `loadAllChunks()` parallelizes per-file DB queries. Do not introduce `for...of` loops with `await` inside for bulk operations — use `Promise.all(items.map(...))`.

### Canonical hashEdgeId

The `hashEdgeId(projectId, sourceChunkId, targetChunkId, type)` function is defined **once** in `src/graph/types.ts` and imported everywhere. `GraphStore.ts` re-exports it for backwards compatibility. Do not duplicate it.

### normalizeResult helper

`CodeIndexer.normalizeResult(result, relPath)` converts absolute paths to project-relative paths, rebuilds stable chunk IDs, and remaps raw edges to use the new IDs. Both `indexProject()` and `indexFileInternal()` use this — do not copy-paste the logic.

### chunkSourceInternal

`TreeSitterChunker.chunkSourceInternal()` is the single dispatch point for all language handlers. `chunkSource()` and `chunkSourceWithEdges()` both call it. Add new language support there, not in both public methods.

### ESM imports

The codebase is pure ESM (`"type": "module"` in package.json). Do not use `require()`. The `@kreuzberg/tree-sitter-language-pack` package's `extract` function is not in its published types — access it via `(languagePack as any).extract`.

### Error events

`indexFileInternal()` wraps its body in try/catch and emits `{ type: "error", filePath, error }` on failure. The `onIndexed` callback receives these. Do not swallow errors silently in the watcher path.

### Debounced hash saving

In watch mode, `saveFileHashes()` is debounced with a 2-second timer (`scheduleSaveFileHashes()`). Do not call `saveFileHashes()` directly from the watcher path.

---

## Conventions

- **Formatter/linter:** Biome — 2-space indent, LF line endings, double quotes. Run `bun run lint` before committing.
- **TypeScript:** Strict mode with `exactOptionalPropertyTypes`. `prop?: string` is distinct from `prop: string | undefined`. Use conditional spreads when assigning optional properties.
- **Test runner:** Bun. Tests live in `src/tests/`. Integration tests are guarded by `if (!process.env.INTEGRATION_TESTS)`.
- **Module bundler:** tsdown — produces `dist/index.mjs` (library) and `dist/cli.mjs` (CLI binary).
- **Package manager:** pnpm (lockfile is `pnpm-lock.yaml`).
- **Node target:** ≥ 20.

---

## Adding a new language

All 305 languages supported by `@kreuzberg/tree-sitter-language-pack` are loaded lazily on first encounter — no opt-in required. To add custom chunking rules for a language:

1. Add a handler branch in `TreeSitterChunker.chunkSourceInternal()`.
2. Check the language pack docs for the correct language identifier string.

---

## Extending the public API

The `CodeIndexer` class is the only public API surface (besides types). If you add a method:
- Export any new types from `src/types.ts`.
- Add the type to the export list in `src/index.ts`.
- Keep `LanceDBStore` and `GraphStore` as internal implementation details — don't export them.

---

## Common pitfalls

| Pitfall | Correct approach |
|---------|-----------------|
| SQL injection in LanceDB filters | Use `sqlStr()` for all interpolated values |
| Serial `for...of await` for bulk ops | `Promise.all(items.map(...))` |
| Calling `saveFileHashes()` directly in watcher | Call `scheduleSaveFileHashes()` instead |
| Duplicating `hashEdgeId` | Import from `src/graph/types.ts` |
| Adding language dispatch in two places | Only in `chunkSourceInternal()` |
| `require()` in ESM module | Use `import` + `(pkg as any).missingExport` |
