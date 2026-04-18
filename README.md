# Lucerna

AST-aware code indexer, search engine, and knowledge graph for AI agents.

Parses your codebase with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), stores structured chunks in an embedded [LanceDB](https://lancedb.com/) database, and exposes hybrid vector + BM25 search with an optional knowledge graph.

**[Full documentation at lucerna.upstart.gg](https://lucerna.upstart.gg)**

---

## Features

- **AST-based chunking** — extracts functions, classes, methods, interfaces, type aliases, and heading sections rather than arbitrary line ranges
- **Hybrid search** — combines semantic (vector) and lexical (BM25 full-text) search via Reciprocal Rank Fusion
- **Optional reranking** — second-stage cross-encoder reranking to improve precision after RRF fusion
- **Knowledge graph** — AST-extracted call, import, and inheritance edges stored in a persisted graph; traverse callers, callees, and dependencies, or expand search results with graph context
- **Repo map** — aider-style concise listing of all indexed files and their top-level symbols
- **Recall evaluation** — built-in `eval` command measures recall@k against a JSONL query set
- **Fully embedded** — uses LanceDB; the index is a directory on disk, one per project
- **Multi-project** — multiple `CodeIndexer` instances in the same process, each fully isolated
- **File watching** — debounced incremental re-indexing via chokidar; watcher path uses an in-memory chunk cache (no full DB scan per file change)
- **Pluggable embeddings** — local (`HFEmbeddings`, `BGESmallEmbeddings`, `JinaCodeEmbeddings`) or remote (`CloudflareEmbeddings`); swap or disable entirely
- **Popular languages** — custom AST-aware chunkers for Python, Java, Go, Rust, TypeScript/JavaScript, C/C++, C#, Swift, Kotlin, Ruby, PHP, Bash, Scala, Lua, R, Dart, Haskell, Elixir, Clojure, Groovy, Perl, PowerShell, MATLAB, Zig, Solidity, SQL, JSON, Markdown, XML, and more
- **Gitignore-aware** — `.gitignore` files at any depth are always respected during indexing and watching
- **CLI** — `lucerna index / watch / search / graph / stats / clear / eval`

---

## MCP server

Register Lucerna as an MCP server with your AI client (Claude Code, Cursor, Windsurf, Zed, VS Code, and more):

```bash
npx add-mcp "@upstart.gg/lucerna mcp-server" --name lucerna
```

---

## CLI

```bash
npx @upstart.gg/lucerna index /path/to/project
npx @upstart.gg/lucerna search /path/to/project "authentication middleware"
```

Or install globally for repeated use:

```bash
npm install -g @upstart.gg/lucerna
lucerna index /path/to/project
```

---

## Programmatic usage

```bash
npm install @upstart.gg/lucerna
```

```ts
import { CodeIndexer } from '@upstart.gg/lucerna';

const indexer = new CodeIndexer({ projectRoot: '/path/to/project' });
await indexer.initialize();
await indexer.indexProject();

const results = await indexer.search('authentication middleware', { limit: 5 });
await indexer.close();
```

For the full API reference, embedding options, CLI docs, and more — see [lucerna.upstart.gg](https://lucerna.upstart.gg).

---

## License

MIT
