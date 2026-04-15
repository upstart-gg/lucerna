# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 10
- [Bun](https://bun.sh/) >= 1.2 (used as test runner)

## Setup

```sh
pnpm install
```

## Scripts

| Script | Description |
|---|---|
| `pnpm build` | Compile TypeScript → `dist/` (ESM) |
| `pnpm dev` | Run the CLI directly from source |
| `pnpm test` | Run unit tests with Bun |
| `pnpm test:integration` | Run integration tests (requires env vars — see below) |
| `pnpm typecheck` | Type-check with tsgo (no emit) |
| `pnpm lint` | Lint and auto-fix with Biome |
| `pnpm ci:lint` | Lint in read-only CI mode (exits non-zero on issues) |
| `pnpm bench` | Run benchmarks |
| `pnpm bench:no-semantic` | Run benchmarks without semantic (embedding) features |
| `pnpm changeset` | Create a new changeset describing your change |
| `pnpm changeset:version` | Apply pending changesets (bump version + update CHANGELOG) |
| `pnpm changeset:publish` | Publish the package to npm |

## Project Structure

```
src/
├── index.ts              # Public API exports
├── types.ts              # Shared TypeScript types
├── CodeIndexer.ts        # Main indexer orchestration
├── chunker/              # AST-aware code chunking (Tree-sitter)
├── cli/                  # CLI entry point (commander)
├── embeddings/           # Embedding model adapters
│   ├── BGESmallEmbeddings.ts
│   ├── HFEmbeddings.ts
│   └── CloudflareEmbeddings.ts
├── graph/                # Symbol graph / call-graph traversal
├── search/               # Hybrid search (vector + lexical)
├── store/                # Storage backends (LanceDB, graph)
├── watcher/              # File-system watcher (chokidar)
└── tests/                # Unit and integration tests
```

## Integration Tests

Integration tests require real backends and are skipped in standard CI. To run locally:

```sh
pnpm test:integration
```

Required environment variables (add to `.env`):

```sh
# Cloudflare Workers AI (for CloudflareEmbeddings / CloudflareReranker)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
```

Integration tests are automatically run on every push to `main` where secrets are available.

## Release Cycle

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and changelog management.

### Making a change

1. Create a feature branch and make your changes.
2. Run `pnpm changeset` to create a changeset file describing the change:
   - Choose the bump type: `patch` (bug fix), `minor` (new feature), or `major` (breaking change)
   - Write a short description — this becomes the CHANGELOG entry
3. Commit the changeset file alongside your code changes.
4. Open a pull request.

### What happens automatically

- **On PR open/update** — CI runs: build, lint, typecheck, and unit tests.
- **On PR merge to `main`** — if a changeset file is present, a canary snapshot is published to npm under the `canary` tag and a comment is posted on the PR with the install command.
- **Version PR** — the release workflow automatically opens (or updates) a PR titled "chore: version packages" that aggregates all pending changesets into a version bump and updated CHANGELOG.
- **On version PR merge** — the release workflow publishes the new version to npm with SLSA provenance (requires approval from the `npm-publish` environment).

### Publishing manually

```sh
# Bump versions based on pending changesets
pnpm changeset:version

# Publish to npm
pnpm changeset:publish
```

> Make sure you are authenticated with npm (`npm login`) and have publish access to the `@upstart.gg/lucerna` package.
