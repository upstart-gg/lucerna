---
name: "lucerna"
description: "Guide to using the `lucerna search` and `lucerna graph` CLI commands for querying and navigating a codebase index."
---
# Lucerna — CLI skill guide

## lucerna search

```
lucerna search <project-root> <query> [options]
```

| Flag | Default | Description |
|---|---|---|
| `--limit <n>` | `10` | Maximum number of results to return |
| `--language <lang>` | *(all)* | Filter by language: `typescript`, `python`, `rust`, `go`, `java`, etc. |
| `--type <type>` | *(all)* | Filter by chunk type: `function` · `class` · `method` · `interface` · `type` · `variable` · `import` · `section` · `file` |
| `--no-semantic` | *(hybrid)* | Disable vector search — run BM25 lexical only |
| `--format raw\|json\|pretty-json` | `raw` | Output format — use `json` when piping results |

### Query guidance

- **Combine intent with technical terms.** "JWT token verify session middleware auth" retrieves better than "where is authentication implemented". Semantic search handles intent; BM25 handles exact identifiers.
- **Use `--no-semantic` for exact symbol names.** Identifiers like `UserRepository` or `ERR_CONN_RESET` match better with BM25 alone.
- **Narrow with `--type` before raising `--limit`.** Filtering to `function` or `method` reduces noise more reliably than increasing result count.

---

## lucerna graph

```
lucerna graph <project-root> <chunk-id> [options]
```

Traverses the knowledge graph for a chunk. The `<chunk-id>` comes from the `id` field in `lucerna search --format json` output.

| Flag | Default | Description |
|---|---|---|
| `--relation <type>` | `neighborhood` | Which relationship to traverse (see below) |
| `--depth <n>` | `1` | BFS depth for `neighborhood` traversal |
| `--format raw\|json\|pretty-json` | `raw` | Output format |

### Relation types

| Relation | Description |
|---|---|
| `neighborhood` | BFS traversal of all edges up to `--depth` hops (default) |
| `callers` | Chunks that call this function/method |
| `callees` | Chunks that this function/method calls |
| `implementors` | Classes that implement or extend this interface/class |
| `super-types` | Interfaces/classes that this chunk extends or implements |
| `usages` | Chunks that reference this symbol |

### Search → graph pipeline

```bash
# Find callers of a function
ID=$(lucerna search . "verifyToken" --no-semantic --type function --format json | jq -r '.[0].id')
lucerna graph . "$ID" --relation callers --format json
```
