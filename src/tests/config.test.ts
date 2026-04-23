import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, loadConfig } from "../config.js";
import { CodeIndexer } from "../CodeIndexer.js";

// ---------------------------------------------------------------------------
// loadConfig() — directory walk contract
//
// Pins the rule the product relies on: the config is discovered by walking up
// from the caller-provided projectRoot. `--dir` (projectRoot) decides where
// we look; the process cwd is irrelevant. A regression here would re-introduce
// the class of bug where `--dir /other/path` silently ignored the user's
// lucerna.config.ts and fell back to wrong defaults.
// ---------------------------------------------------------------------------

describe("loadConfig — directory walk", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-config-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds lucerna.config.ts in projectRoot itself", async () => {
    const projectRoot = join(tmpDir, "proj");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "lucerna.config.ts"),
      `export default { exclude: ["foo"] };\n`,
    );

    const { config, configDir } = await loadConfig(projectRoot);
    expect(configDir).toBe(projectRoot);
    expect(config.exclude).toEqual(["foo"]);
  });

  test("finds config in an ancestor of projectRoot", async () => {
    const ancestor = join(tmpDir, "anc");
    const sub = join(ancestor, "deeper", "still");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(ancestor, "lucerna.config.ts"),
      `export default { exclude: ["ancestor-hit"] };\n`,
    );

    const { config, configDir } = await loadConfig(sub);
    expect(configDir).toBe(ancestor);
    expect(config.exclude).toEqual(["ancestor-hit"]);
  });

  test("does NOT find config in an unrelated directory (cwd decoupled from projectRoot)", async () => {
    const projectRoot = join(tmpDir, "proj");
    const unrelated = join(tmpDir, "elsewhere");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(
      join(unrelated, "lucerna.config.ts"),
      `export default { exclude: ["should-not-load"] };\n`,
    );

    // Deliberately cd into the unrelated dir — loadConfig must still only
    // walk from projectRoot upwards, so it should miss the unrelated config.
    const origCwd = process.cwd();
    try {
      process.chdir(unrelated);
      const { config, configDir } = await loadConfig(projectRoot);
      expect(configDir).toBeNull();
      expect(config.exclude).toBeUndefined();
    } finally {
      process.chdir(origCwd);
    }
  });

  test("returns empty config when no config exists anywhere up the tree", async () => {
    const projectRoot = join(tmpDir, "nothing");
    await mkdir(projectRoot, { recursive: true });
    const { config, configDir } = await loadConfig(projectRoot);
    expect(configDir).toBeNull();
    expect(config).toEqual({});
  });

  test("supports .js extension", async () => {
    const projectRoot = join(tmpDir, "js");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "lucerna.config.js"),
      `export default { exclude: ["js-hit"] };\n`,
    );
    const { config, configDir } = await loadConfig(projectRoot);
    expect(configDir).toBe(projectRoot);
    expect(config.exclude).toEqual(["js-hit"]);
  });
});

// ---------------------------------------------------------------------------
// createDefaultConfig() writes to the target dir (not cwd)
//
// Direct unit coverage of the helper. The callsite-regression tests (CLI and
// MCP passing the right arg) live in cli.dist.test.ts.
// ---------------------------------------------------------------------------

describe("createDefaultConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-defconf-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates lucerna.config.ts in the given directory", async () => {
    const target = join(tmpDir, "t");
    await mkdir(target, { recursive: true });
    await createDefaultConfig(target);
    expect(existsSync(join(target, "lucerna.config.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CodeIndexer auto-loads config when embeddingFunction is omitted
//
// This is the programmatic-usage regression. Before the fix, `new CodeIndexer`
// ignored `lucerna.config.ts` entirely when the caller didn't pass an explicit
// embeddingFunction, silently falling back to a hardcoded 384-dim vector table
// that would mismatch whatever the config actually specified.
// ---------------------------------------------------------------------------

describe("CodeIndexer — config auto-load (programmatic)", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lucerna-autoload-"));
    projectRoot = join(tmpDir, "project");
    storageDir = join(projectRoot, ".lucerna");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "a.ts"),
      `export function greet(name: string) { return "hi " + name; }\n`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("picks up embedding config from lucerna.config.ts at projectRoot", async () => {
    await writeFile(
      join(projectRoot, "lucerna.config.ts"),
      `export default {
         embedding: { provider: "ollama", model: "nomic-embed-text" }
       };\n`,
    );

    const indexer = new CodeIndexer({ projectRoot });
    await indexer.initialize();
    // The store writes meta on fresh init when a dim is known — reading the
    // meta file is the cleanest way to observe the resolved dim/modelId.
    const metaPath = join(storageDir, "index-meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    // nomic-embed-text → 768-dim per OllamaEmbeddings' MODEL_DIMENSIONS table.
    expect(meta.dimensions).toBe(768);
    expect(meta.modelId).toBe("nomic-embed-text");
    await indexer.close();
  });

  test("uses config in an ancestor of projectRoot", async () => {
    const sub = join(projectRoot, "nested", "area");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(projectRoot, "lucerna.config.ts"),
      `export default {
         embedding: { provider: "ollama", model: "mxbai-embed-large" }
       };\n`,
    );

    const indexer = new CodeIndexer({ projectRoot: sub });
    await indexer.initialize();
    const meta = JSON.parse(
      await readFile(join(sub, ".lucerna", "index-meta.json"), "utf8"),
    );
    expect(meta.dimensions).toBe(1024);
    expect(meta.modelId).toBe("mxbai-embed-large");
    await indexer.close();
  });

  test("explicit embeddingFunction: false opts out of auto-load (lexical-only, no vec table)", async () => {
    await writeFile(
      join(projectRoot, "lucerna.config.ts"),
      `export default {
         embedding: { provider: "ollama", model: "nomic-embed-text" }
       };\n`,
    );

    const indexer = new CodeIndexer({
      projectRoot,
      embeddingFunction: false,
    });
    await indexer.initialize();
    // No meta file should be written — we have no dim to persist.
    expect(existsSync(join(storageDir, "index-meta.json"))).toBe(false);
    await indexer.close();
  });

  test("no config + no embeddingFunction — initializes without vec table; lexical indexing still works", async () => {
    const indexer = new CodeIndexer({ projectRoot });
    await indexer.initialize();
    const stats = await indexer.indexProject();
    expect(stats.totalChunks).toBeGreaterThan(0);
    // No meta (no dim) — pins the "no 384 fallback" invariant.
    expect(existsSync(join(storageDir, "index-meta.json"))).toBe(false);

    const results = await indexer.searchLexical("greet", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    await indexer.close();
  });
});
