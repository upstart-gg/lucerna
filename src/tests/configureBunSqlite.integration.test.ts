// macOS-only tests for the sqlite-vec / bun:sqlite interop path.
//
// Three things we want to verify on a real macOS machine:
//   1. `findCustomSqliteLib()` resolves to an actual dylib on disk.
//   2. In a fresh Bun process, `configureBunSqlite()` + opening a DB +
//      loading sqlite-vec succeeds end-to-end. This is the real regression
//      test — without this, macOS breakage only surfaces to end-users.
//   3. If a Database is opened BEFORE `configureBunSqlite()` runs, the
//      helper logs a diagnostic and the subsequent `loadExtension` throws
//      the user-friendly error message (not a cryptic C-level one).
//
// Tests 2 and 3 must run in subprocesses because `setCustomSQLite` is
// once-per-process — we cannot reset state inside the test runner.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCustomSqliteLib } from "../store/SqliteVectorStore.js";

const IS_MAC = process.platform === "darwin";
const REPO_ROOT = join(import.meta.dir, "..", "..");

function runBun(script: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "lucerna-bunsqlite-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, script);
  const result = spawnSync("bun", [file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe.skipIf(!IS_MAC)("configureBunSqlite (macOS)", () => {
  test("findCustomSqliteLib resolves to an existing dylib", () => {
    const libPath = findCustomSqliteLib();
    // If Homebrew sqlite isn't installed on this machine, skip rather than
    // fail — the helper correctly returns null in that case.
    if (!libPath) {
      console.warn(
        "[test] No Homebrew sqlite dylib found — skipping. " +
          "Install with: brew install sqlite",
      );
      return;
    }
    expect(existsSync(libPath)).toBe(true);
    expect(libPath).toMatch(/libsqlite3\.dylib$/);
  });

  test("LUCERNA_SQLITE_LIB override is honoured", () => {
    const prev = process.env.LUCERNA_SQLITE_LIB;
    try {
      process.env.LUCERNA_SQLITE_LIB =
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
      const libPath = findCustomSqliteLib();
      if (existsSync(process.env.LUCERNA_SQLITE_LIB)) {
        expect(libPath).toBe(process.env.LUCERNA_SQLITE_LIB);
      }
      // Non-existent override falls through to the Homebrew candidates.
      process.env.LUCERNA_SQLITE_LIB = "/nonexistent/libsqlite3.dylib";
      const fallback = findCustomSqliteLib();
      expect(fallback).not.toBe("/nonexistent/libsqlite3.dylib");
    } finally {
      if (prev === undefined) delete process.env.LUCERNA_SQLITE_LIB;
      else process.env.LUCERNA_SQLITE_LIB = prev;
    }
  });

  test("fresh process: configureBunSqlite + loadExtension succeeds", () => {
    if (!findCustomSqliteLib()) return; // skip when brew sqlite missing

    // This is the real regression test: it exercises the exact path the
    // end-user sees when embedding lucerna. If this passes, sqlite-vec can
    // actually load inside a Bun process that used configureBunSqlite().
    const { status, stdout, stderr } = runBun(`
      import { configureBunSqlite, SqliteVectorStore } from "${REPO_ROOT}/src/index.ts";
      import { mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";

      const applied = configureBunSqlite();
      if (!applied) {
        console.error("configureBunSqlite returned null");
        process.exit(2);
      }

      const dir = mkdtempSync(join(tmpdir(), "lucerna-probe-"));
      const store = new SqliteVectorStore({ storageDir: dir, dimensions: 8 });
      await store.initialize();
      await store.close();
      console.log("OK:" + applied);
    `);
    expect(stderr).not.toMatch(/does not support.*extension/i);
    expect(status).toBe(0);
    expect(stdout).toMatch(/OK:\/.*libsqlite3\.dylib/);
  });

  test("late call: configureBunSqlite logs a clear diagnostic", () => {
    if (!findCustomSqliteLib()) return;

    // Open a bun:sqlite Database *before* configureBunSqlite — simulates a
    // host program that touched sqlite before importing lucerna.
    const { status, stdout } = runBun(`
      import { Database } from "bun:sqlite";
      new Database(":memory:");                 // seals SQLite choice
      const { configureBunSqlite } = await import("${REPO_ROOT}/src/index.ts");
      const result = configureBunSqlite();
      console.log("RESULT:" + (result ?? "null"));
    `);
    // The helper should return null and log a diagnostic pointing at the race.
    expect(status).toBe(0);
    expect(stdout).toContain("RESULT:null");
    expect(stdout).toMatch(/configureBunSqlite.*already loaded/i);
  });

  test("late open: loadExtension throws the friendly error", () => {
    if (!findCustomSqliteLib()) return;

    // Same race, but this time let lucerna actually try to open its DB —
    // we should get the rewritten, user-friendly error, not the raw one.
    const { status, stderr } = runBun(`
      import { Database } from "bun:sqlite";
      new Database(":memory:");
      const { SqliteVectorStore } = await import("${REPO_ROOT}/src/index.ts");
      import { mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const dir = mkdtempSync(join(tmpdir(), "lucerna-probe-"));
      const store = new SqliteVectorStore({ storageDir: dir, dimensions: 8 });
      try {
        await store.initialize();
        console.log("UNEXPECTED_SUCCESS");
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    `);
    expect(status).toBe(1);
    expect(stderr).toMatch(/configureBunSqlite/);
    expect(stderr).toMatch(/once-per-process/);
  });
});
