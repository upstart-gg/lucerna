---
name: "lucerna"
description: "Guide for agents using the lucerna MCP tools to search and navigate a codebase index."
---
# Lucerna — MCP tool guide

Lucerna exposes two tools: **`search_codebase`** and **`get_neighbors`**.

---

## `search_codebase`

Hybrid semantic + lexical (BM25) search over the indexed codebase. The primary tool — use it first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Search query |
| `includeGraphContext` | boolean | `true` | Expand results with related symbols from the knowledge graph |
| `graphDepth` | integer 0–3 | `1` | Hops to follow when expanding graph context |
| `limit` | integer 1–100 | `10` | Max results per page |
| `offset` | integer ≥ 0 | `0` | Results to skip — use for pagination when `hasMore` is `true` |
| `includeContent` | boolean | `true` | Include chunk source code. Set `false` for metadata-only (filePath, name, type, lines) — much smaller response |
| `language` | string | *(all)* | Filter by language. Common values: `typescript` · `javascript` · `tsx` · `jsx` · `python` · `rust` · `go` · `java` · `csharp` · `cpp` · `c` · `ruby` · `php` · `swift` · `kotlin` · `scala` · `dart` · `elixir` · `clojure` · `haskell` · `ocaml` · `erlang` · `sql` · `solidity` · `bash` · `powershell` · `perl` · `r` · `julia` · `matlab` · `groovy` · `zig` · `lua` · `objc` · `scss` · `css` · `html` · `vue` · `svelte` · `markdown` · `json` · `yaml` · `toml`. Any language supported by tree-sitter-language-pack is accepted. |
| `type` | string | *(all)* | Filter by chunk type. Most common: `function` · `method` · `class` · `interface` · `type` · `enum` · `const` · `variable` · `import`. Also available: `struct` · `record` · `trait` · `protocol` · `mixin` · `extension` · `object` · `actor` · `namespace` · `module` · `macro` · `typealias` · `property` · `instance` · `newtype` · `functor` · `module_type` · `test` · `param_block` · `dsl_call` · `state_variable` · `event` · `modifier` · `error` · `library` · `section` (markdown headings) · `file` (whole-file fallback). |
| `filePath` | string | *(all)* | Filter by file path (supports glob patterns) |

### Response shape

```json
{
  "results": [...],
  "hasMore": true,
  "offset": 10
}
```

| Field | Description |
|---|---|
| `results` | Array of flat result objects (see fields below) |
| `hasMore` | `true` if more results exist beyond the current page |
| `offset` | Only present when non-zero — the offset used for this page |
| `warning` | Present when indexing is still in progress or semantic search is unavailable — retry in a few seconds |

Each result object has these fields:

| Field | Always present | Description |
|---|---|---|
| `id` | yes | Chunk ID — pass to `get_neighbors` |
| `loc` | yes | `"filePath:startLine-endLine"` — e.g. `"src/auth/middleware.ts:12-17"` |
| `type` | yes | Chunk type: `function` · `class` · `method` · etc. |
| `score` | yes | Relevance score 0–1, rounded to 2 decimal places |
| `name` | when named | Symbol name (function/class/method/heading) |
| `content` | when `includeContent: true` | Raw source code of the chunk |
| `metadata` | when non-empty | Language-specific extra fields |

---

## `get_neighbors`

Traverses the knowledge graph for a specific chunk. Use it to explore callers, callees, imports, and other relationships that `search_codebase` didn't surface directly.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `chunkId` | string | required | The `id` field from a `search_codebase` result (top-level, not nested) |
| `depth` | integer 1–3 | `1` | How many hops to traverse |

---

## When to use each tool

- **`search_codebase` first, always.** It already includes graph context by default (`includeGraphContext: true`). For most questions about the codebase, one call is enough.
- **`get_neighbors` when you need to go deeper.** If a result looks relevant but you need to understand what calls it, what it calls, or what it imports — fetch its neighborhood explicitly.
- **Don't call `get_neighbors` preemptively** on every search result. Use it only when a specific chunk warrants deeper exploration.

---

## Query guidelines

- **Mix intent with identifiers.** `"JWT token verify session middleware"` retrieves better than `"where is authentication implemented"`. Semantic search handles intent; BM25 handles exact names.
- **Exact symbol lookups:** for known identifiers like `UserRepository` or `ERR_CONN_RESET`, a precise query with the symbol name works best.
- **Narrow with `type` before raising `limit`.** Filtering to `function` or `method` reduces noise more reliably than increasing the result count.
- **Use `filePath` to scope to a module.** When you already know which file or directory is relevant, filter to it.

---

## Best practices

- If results look incomplete, check for a `warning` field in the response — indexing may still be running.
- Prefer one well-formed query over multiple narrow ones. The hybrid ranker handles broad queries well.
- `graphDepth: 2` is rarely needed. Start at `1`; only go deeper if the direct neighborhood is insufficient.
- **Pagination:** when `hasMore` is `true`, call again with `offset` incremented by `limit` to fetch the next page. Stop when `hasMore` is `false` or `results` is empty.
- **Token-efficient survey:** use `includeContent: false` to locate relevant files first, then read the ones you need with a file-reading tool. Use the default `includeContent: true` when you need to understand the code in a single call.
