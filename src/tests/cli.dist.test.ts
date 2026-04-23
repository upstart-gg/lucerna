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

/**
 * Asserts the command exited 0. On failure, dumps stdout+stderr to the test
 * log so CI failures aren't opaque.
 */
function expectSuccess(result: RunResult): void {
  if (result.exitCode !== 0) {
    console.error(
      `\n--- command failed (exit=${result.exitCode}) ---\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n---`,
    );
  }
  expect(result.exitCode).toBe(0);
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

  // Pin the backend so this smoke test isn't implicitly coupled to whichever
  // default CodeIndexer picks. Makes failures unambiguous and lets us run the
  // suite against either backend by flipping this one line.
  await writeFile(
    join(projectDir, "lucerna.config.ts"),
    `export default { vectorStore: "sqlite" };\n`,
  );
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
    const result = run([
      "index",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expectSuccess(result);
    expect(result.stdout).toContain("Done");
    expect(result.stdout).toMatch(/\d+ files/);
    expect(result.stdout).toMatch(/\d+ chunks/);
  });

  test("stats command shows project statistics", () => {
    // Relies on the index created by the previous test
    const result = run([
      "stats",
      "--dir",
      projectDir,
      "--storage-dir",
      storageDir,
    ]);
    expectSuccess(result);
    expect(result.stdout).toContain("Total files");
    expect(result.stdout).toContain("Total chunks");
  });

  test("stats --format json outputs valid JSON", () => {
    const result = run([
      "stats",
      "--dir",
      projectDir,
      "--storage-dir",
      storageDir,
      "--format",
      "json",
    ]);
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("totalFiles");
    expect(parsed).toHaveProperty("totalChunks");
  });

  test("search command returns results", () => {
    const result = run([
      "search",
      "add",
      "--dir",
      projectDir,
      "--no-semantic",
      "--storage-dir",
      storageDir,
    ]);
    expectSuccess(result);
    // Either results or "No results found." — the command should not crash
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("search --format json outputs valid JSON array", () => {
    const result = run([
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
    expectSuccess(result);
    // Could be an empty array or results — either is valid JSON
    if (result.stdout.trim().startsWith("[")) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  // ---------------------------------------------------------------------
  // Regression: `--dir <path>` with no pre-existing config must write the
  // auto-generated lucerna.config.ts to <path>, NOT to cwd. Prior behavior
  // dropped it in cwd where loadConfig(projectRoot) could never find it.
  // ---------------------------------------------------------------------
  test("index --dir <fresh-dir> writes default config into --dir (not cwd)", async () => {
    const freshProject = join(tmpDir, "fresh-project-config-regress");
    await mkdir(freshProject, { recursive: true });
    await writeFile(join(freshProject, "x.ts"), `export const x = 1;\n`);
    const freshStorage = join(tmpDir, "fresh-storage-config-regress");

    // Deliberately run from a DIFFERENT cwd so we can assert the config
    // lands in freshProject (the --dir), not cwd.
    const { existsSync } = await import("node:fs");
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = run([
        "index",
        "--dir",
        freshProject,
        "--no-semantic",
        "--storage-dir",
        freshStorage,
      ]);
      expectSuccess(result);
      expect(existsSync(join(freshProject, "lucerna.config.ts"))).toBe(true);
      // And pointedly NOT in cwd.
      expect(existsSync(join(tmpDir, "lucerna.config.ts"))).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("mcp-server --dir <fresh-dir> writes default config into --dir (not cwd)", async () => {
    const freshProject = join(tmpDir, "fresh-mcp-config-regress");
    await mkdir(freshProject, { recursive: true });
    const freshStorage = join(tmpDir, "fresh-mcp-storage-regress");

    const { existsSync } = await import("node:fs");
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // MCP listens on stdio — spawn, give it a moment to run the config
      // resolution code path, then kill. The config file write happens
      // synchronously-early in startMcpServer().
      const proc = Bun.spawn(
        [
          "node",
          CLI,
          "mcp-server",
          "--dir",
          freshProject,
          "--no-semantic",
          "--storage-dir",
          freshStorage,
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
      );
      // Wait for startMcpServer's loadConfig + createDefaultConfig to run.
      // 800ms is comfortably above the config-write latency on a dev machine.
      await new Promise((r) => setTimeout(r, 800));
      proc.kill("SIGKILL");

      expect(existsSync(join(freshProject, "lucerna.config.ts"))).toBe(true);
      expect(existsSync(join(tmpDir, "lucerna.config.ts"))).toBe(false);
    } finally {
      process.chdir(origCwd);
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
    const result = run([
      "clear",
      "--dir",
      projectDir,
      "--storage-dir",
      clearStorage,
    ]);
    expectSuccess(result);
    expect(result.stdout).toContain("Cleared");
  });
});
