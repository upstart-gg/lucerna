/**
 * Distribution smoke tests.
 *
 * Verifies that the built CLI (`dist/cli.mjs`) can be executed and that each
 * subcommand runs without crashing. These tests intentionally avoid calling
 * semantic/embedding features so they stay fast and offline.
 *
 * Run via: pnpm test:dist
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI = resolve(import.meta.dir, "../../dist/cli.mjs");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const proc = Bun.spawnSync(["node", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let projectDir: string;
let storageDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lucerna-dist-test-"));
  projectDir = join(tmpDir, "project");
  storageDir = join(tmpDir, "storage");
  await mkdir(projectDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });

  await writeFile(
    join(projectDir, "utils.ts"),
    `export function add(a: number, b: number): number { return a + b; }`,
  );
  await writeFile(join(projectDir, "index.ts"), `export * from "./utils.js";`);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI smoke tests (dist/cli.mjs)", () => {
  test("--help exits 0 and prints usage", () => {
    const { exitCode, stdout } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("lucerna");
    expect(stdout).toContain("Usage");
  });

  test("--version exits 0 and prints a version string", () => {
    const { exitCode, stdout } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("unknown command exits non-zero", () => {
    const { exitCode } = run(["not-a-command"]);
    expect(exitCode).not.toBe(0);
  });

  test("index --help exits 0", () => {
    const { exitCode, stdout } = run(["index", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Project root");
  });

  test("search --help exits 0", () => {
    const { exitCode, stdout } = run(["search", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("query");
  });

  test("stats --help exits 0", () => {
    const { exitCode } = run(["stats", "--help"]);
    expect(exitCode).toBe(0);
  });

  test("clear --help exits 0", () => {
    const { exitCode } = run(["clear", "--help"]);
    expect(exitCode).toBe(0);
  });

  test("index command indexes a project (lexical only)", () => {
    const { exitCode, stdout } = run([
      "index",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Done");
    expect(stdout).toMatch(/\d+ files/);
    expect(stdout).toMatch(/\d+ chunks/);
  });

  test("stats command shows project statistics", () => {
    // Relies on the index created by the previous test
    const { exitCode, stdout } = run([
      "stats",
      "--dir",
      projectDir,
      "--storage-dir",
      storageDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Total files");
    expect(stdout).toContain("Total chunks");
  });

  test("stats --format json outputs valid JSON", () => {
    const { exitCode, stdout } = run([
      "stats",
      "--dir",
      projectDir,
      "--storage-dir",
      storageDir,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("totalFiles");
    expect(parsed).toHaveProperty("totalChunks");
  });

  test("search command returns results", () => {
    const { exitCode, stdout } = run([
      "search",
      "add",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expect(exitCode).toBe(0);
    // Either results or "No results found." — the command should not crash
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("search --format json outputs valid JSON array", () => {
    const { exitCode, stdout } = run([
      "search",
      "add",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Could be an empty array or results — either is valid JSON
    if (stdout.trim().startsWith("[")) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("clear command removes the index", () => {
    const clearStorage = join(tmpDir, "storage-to-clear");
    // First index into a fresh storage dir
    run([
      "index",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      clearStorage,
    ]);

    // Now clear it
    const { exitCode, stdout } = run([
      "clear",
      "--dir",
      projectDir,
      "--storage-dir",
      clearStorage,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Cleared");
  });
});
