// Side-effect module: calls `configureBunSqlite()` on import.
//
// Usage — must be the first import in your entry file, before anything that
// could touch `bun:sqlite`:
//
//   import "@upstart.gg/lucerna/configure";
//   // …the rest of your imports
//
// ESM evaluates imports in source order and runs their top-level code before
// moving on, so putting this first guarantees `setCustomSQLite` runs before
// any other module can open a Database.
//
// Prefer Bun's `--preload` flag when you can — it's less fragile than relying
// on import ordering. See docs/programmatic-usage/quickstart.mdx.

import { configureBunSqlite } from "./store/SqliteVectorStore.js";

configureBunSqlite();
