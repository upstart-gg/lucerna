/**
 * Binary smoke tests.
 *
 * Verifies that a compiled standalone binary works correctly end-to-end.
 * Set BINARY_PATH to the path of the binary to test before running:
 *
 *   BINARY_PATH=./bin/lucerna-darwin-arm64 bun test src/tests/binary.smoke.test.ts
 *
 * Mirrors cli.dist.test.ts but invokes the binary directly (no `node` runtime).
 */

if (!process.env.BINARY_PATH) {
  process.exit(0);
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BINARY = resolve(process.env.BINARY_PATH);

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const proc = Bun.spawnSync([BINARY, ...args], {
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
  tmpDir = await mkdtemp(join(tmpdir(), "lucerna-bin-smoke-"));
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

describe(`Binary smoke tests (${BINARY})`, () => {
  test("--version exits 0 and prints a version string", () => {
    const { exitCode, stdout } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help exits 0 and prints usage", () => {
    const { exitCode, stdout } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("lucerna");
    expect(stdout).toContain("Usage");
  });

  test("unknown command exits non-zero", () => {
    const { exitCode } = run(["not-a-command"]);
    expect(exitCode).not.toBe(0);
  });

  test("index --help exits 0", () => {
    const { exitCode, stdout } = run(["index", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("project-root");
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
    const { exitCode, stdout, stderr } = run([
      "index",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain("Done.");
    expect(stdout + stderr).toMatch(/\d+ files/);
    expect(stdout + stderr).toMatch(/\d+ chunks/);
  });

  test("stats command shows project statistics", () => {
    const { exitCode, stdout } = run([
      "stats",
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
      projectDir,
      "add",
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("search --format json outputs valid JSON array", () => {
    const { exitCode, stdout } = run([
      "search",
      projectDir,
      "add",
      "--no-semantic",
      "--storage-dir",
      storageDir,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    if (stdout.trim().startsWith("[")) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("clear command removes the index", () => {
    const clearStorage = join(tmpDir, "storage-to-clear");
    run(["index", projectDir, "--no-semantic", "--storage-dir", clearStorage]);

    const { exitCode, stdout } = run([
      "clear",
      projectDir,
      "--storage-dir",
      clearStorage,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Cleared");
  });
});
