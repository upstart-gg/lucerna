# Lucerna — Developer & Agent Guide

> **For AI coding assistants.** This file explains what Lucerna does, how the codebase is structured, and what conventions to follow when making changes. Read this before editing anything.

---

## What it is

Check out the [README](README.md) for a high-level overview of Lucerna's features, and [user docs](./docs) for how users interact with it.

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

## Conventions

- **Formatter/linter:** Biome — 2-space indent, LF line endings, double quotes. Run `bun run lint` before committing.
- **TypeScript:** Strict mode with `exactOptionalPropertyTypes`. `prop?: string` is distinct from `prop: string | undefined`. Use conditional spreads when assigning optional properties.
- **Test runner:** Bun. Tests live in `src/tests/`. Integration tests are guarded by `if (!process.env.INTEGRATION_TESTS)`.
- **Module bundler:** tsdown — produces `dist/index.mjs` (library) and `dist/cli.mjs` (CLI binary).
- **Package manager:** pnpm (lockfile is `pnpm-lock.yaml`).
- **Node target:** ≥ 20.

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


---

## Development guidelines

- Strict TypeScript (never use `any` or disable rules without a very good reason)
- Always check for existing utilities/helpers before adding new ones
- Always check that `bun lint` and `bun typecheck` pass before committing (no warnings accepted!)
- Make sure `bun run build` completes successfully and that the output looks correct
- Make sure `pnpm bench` completes successfully and that benchmarks look reasonable
- Write tests for new features and bug fixes; follow existing test patterns
