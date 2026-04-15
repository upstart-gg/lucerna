---
name: "lucerna"
description: "Guide to using the `lucerna search`, `lucerna graph`, `lucerna stats`, and `lucerna eval` CLI commands for querying, navigating, and evaluating your codebase index."
---
# lucerna — CLI skill guide

## lucerna search

### Synopsis

```
lucerna search <project-root> <query> [options]
```

Searches a pre-built index. The project must already be indexed (`lucerna index <project-root>`) before running search.

`lucerna index` picks up all 305 languages automatically — Python, Rust, Go, Java, C/C++, and more are indexed out of the box. `.gitignore` files at any depth are always respected.

---

## Options

| Flag | Default | Description |
|---|---|---|
| `--limit <n>` | `10` | Maximum number of results to return |
| `--format json\|table` | `table` | Output format |
| `--language <lang>` | *(all)* | Filter by language: any indexed language, e.g. `typescript`, `python`, `rust`, `go`, `java` |
| `--type <type>` | *(all)* | Filter by chunk type (see below) |
| `--no-semantic` | *(hybrid)* | Disable vector search — run BM25 lexical only |
| `--storage-dir <dir>` | `<project-root>/.lucerna` | Override index location |

### Chunk types for `--type`

`function` · `class` · `method` · `interface` · `type` · `variable` · `import` · `section` · `file`

---

## Search modes

| Mode | When active | Best for |
|---|---|---|
| **Hybrid** (default) | Embeddings available | General queries — semantic intent + keyword match |
| **Lexical only** | `--no-semantic` | Exact symbol names, identifiers, error messages |

Hybrid mode fuses vector and BM25 rankings via Reciprocal Rank Fusion. Both modes share the same `--limit`, `--language`, and `--type` filters.

---

## Output

### Default output

One entry per result: a header line with file, line range, chunk type, name, and any context (e.g. class name or markdown breadcrumb), followed by an indented content snippet (200 chars).

```
src/auth/middleware.ts:12-45  [function] verifyToken
  export function verifyToken(token: string): JWTPayload {

src/auth/AuthMiddleware.ts:20-35  [method] run  className=AuthMiddleware
  run(req: Request, res: Response, next: NextFunction) {

2 result(s)
```

### JSON (`--format json`)

Returns a compact array — useful for piping into other tools or agentic processing. Fields: `id` (chunk ID, usable with `lucerna graph`), `file` (`{path}:{start}-{end}`), `type`, `name` (if applicable), `context` (if non-empty), `content`.

```json
[
  {
    "id": "a3f9b2c1d4e5f6a7",
    "file": "src/auth/middleware.ts:12-45",
    "type": "function",
    "name": "verifyToken",
    "content": "export function verifyToken(token: string): JWTPayload { ... }"
  },
  {
    "id": "b7c4d8e2f1a9b3c5",
    "file": "src/auth/AuthMiddleware.ts:20-35",
    "type": "method",
    "name": "run",
    "context": { "className": "AuthMiddleware" },
    "content": "run(req, res, next) { ... }"
  }
]
```

---

## Usage patterns

### Natural language query
```bash
lucerna search . "authentication middleware that validates JWT tokens"
```

### Exact symbol lookup
```bash
lucerna search . "verifyToken" --no-semantic --type function
```

### Find all methods in a specific language, return more results
```bash
lucerna search . "database connection" --language typescript --type method --limit 20
lucerna search . "database connection" --language python --type function --limit 20
```

### Pipe JSON results to jq
```bash
lucerna search . "error handling" --format json | jq '.[].chunk.filePath' | sort -u
```

### Search a non-default index location
```bash
lucerna search /repos/my-app "cache invalidation" --storage-dir /var/indexes/my-app
```

---

## Best practices

- **Query with intent, not just keywords.** "function that retries HTTP requests with exponential backoff" retrieves better than "retry".
- **Use `--no-semantic` for identifiers.** Exact names like `UserRepository` or `ERR_CONN_RESET` match better with BM25.
- **Narrow with `--type` before raising `--limit`.** Filtering to `method` or `function` reduces noise more reliably than increasing result count.
- **Use `--format json` in scripts.** The table format truncates content; JSON gives you full chunk text, line ranges, and scores.
- **Score is relative, not absolute.** A score of `0.03` can be top-ranked; compare results within a query, not across queries.
- **The index must be current.** If files have changed since the last `index` or `watch` run, results may be stale. Re-run `lucerna index <project-root>` to refresh.

---

## lucerna graph

### Synopsis

```
lucerna graph <project-root> <chunk-id> [options]
```

Traverses the knowledge graph for a chunk. Requires a chunk ID, which is available in `lucerna search --format json` output as the `id` field.

### Options

| Flag | Default | Description |
|---|---|---|
| `--relation <type>` | `neighborhood` | Which relationship to traverse (see below) |
| `--depth <n>` | `1` | BFS depth for `neighborhood` traversal |
| `--format json\|table` | `table` | Output format |
| `--storage-dir <dir>` | `<project-root>/.lucerna` | Override index location |

### Relation types

| Relation | Description |
|---|---|
| `neighborhood` | BFS traversal of all edges up to `--depth` hops (default) |
| `callers` | Chunks that call this function/method (reverse CALLS edges) |
| `callees` | Chunks that this function/method calls (outgoing CALLS edges) |
| `implementors` | Classes that implement or extend this interface/class (reverse IMPLEMENTS/EXTENDS) |
| `super-types` | Interfaces/classes that this chunk extends or implements (outgoing EXTENDS/IMPLEMENTS) |
| `usages` | Chunks that reference this symbol (reverse USES edges) |

### Output

Table format shows one entry per related chunk with file location, type, name, and a 200-char content snippet. JSON format returns an array with `id`, `file`, `type`, `name`, `content` fields — or for `neighborhood`, an object with `center` and `related` (each related entry also includes `relation` and `direction`).

### Usage patterns

#### Find everything that calls a function

```bash
# Step 1: get the chunk ID
ID=$(lucerna search . "verifyToken" --format json | jq -r '.[0].id')

# Step 2: find all callers
lucerna graph . "$ID" --relation callers
```

#### Find all classes implementing an interface

```bash
lucerna graph . "$INTERFACE_CHUNK_ID" --relation implementors
```

#### Explore the neighborhood of a chunk (2 hops)

```bash
lucerna graph . "$CHUNK_ID" --relation neighborhood --depth 2 --format json
```

#### Full search → graph pipeline in JSON

```bash
lucerna search . "authentication" --format json \
  | jq -r '.[0].id' \
  | xargs -I{} lucerna graph . {} --relation callers --format json
```

---

## lucerna stats

### Synopsis

```
lucerna stats <project-root> [options]
```

Shows index statistics: total files, total chunks, last indexed time, and breakdown by language and chunk type.

### Options

| Flag | Default | Description |
|---|---|---|
| `--format json\|table` | `table` | Output format |
| `--storage-dir <dir>` | `<project-root>/.lucerna` | Override index location |

### Output (table)

```
Project:        /repos/my-app
Project ID:     a1b2c3d4
Total files:    142
Total chunks:   3817
Last indexed:   2025-04-15T10:00:00.000Z
```

JSON format returns the full `IndexStats` object, including `byLanguage` and `byType` maps with chunk counts per language and chunk type.

---

## lucerna eval

### Synopsis

```
lucerna eval <project-root> <queries-file> [options]
```

Measures search recall against a JSONL file of labeled queries. Each line must be a JSON object with a `query` string and an `expectedFile` path (relative to project root). An optional `expectedSymbol` string further narrows the match to a specific named chunk.

### Options

| Flag | Default | Description |
|---|---|---|
| `--k <numbers>` | `1,5,10` | Comma-separated k values to evaluate |
| `--format json\|table` | `table` | Output format |
| `--no-semantic` | *(hybrid)* | Disable vector search — run BM25 only |
| `--storage-dir <dir>` | `<project-root>/.lucerna` | Override index location |

### Queries file format (JSONL)

```jsonl
{"query": "function that verifies JWT tokens", "expectedFile": "src/auth/middleware.ts", "expectedSymbol": "verifyToken"}
{"query": "database connection pool", "expectedFile": "src/db/pool.ts"}
```

### Output (table)

```
Evaluation results — 2 queries

  Recall@1  : 50.0%  (1/2)
  Recall@5  : 100.0%  (2/2)
  Recall@10 : 100.0%  (2/2)

Per-query breakdown:
  [@1:✓  @5:✓  @10:✓]  "function that verifies JWT tokens"  →  src/auth/middleware.ts::verifyToken
  [@1:✗  @5:✓  @10:✓]  "database connection pool"  →  src/db/pool.ts
```

JSON format returns `{ total, recallAtK, details }` where `details` is one object per query with `query`, `expectedFile`, optional `expectedSymbol`, and `hitsAtK` (map of k → boolean).

### Usage patterns

#### Quick recall check with hybrid search
```bash
lucerna eval . queries.jsonl --k 1,5,10
```

#### Lexical-only baseline
```bash
lucerna eval . queries.jsonl --k 1,5,10 --no-semantic
```

#### Capture results for CI
```bash
lucerna eval . queries.jsonl --format json > eval-results.json
```
