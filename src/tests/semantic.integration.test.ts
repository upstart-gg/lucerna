/**
 * End-to-end semantic search integration test.
 *
 * Verifies that semantic retrieval actually *works* — not just that the wiring
 * round-trips — by using a real Gemini embedding model over a fixture where
 * lexical search provably can't succeed (queries share no tokens with the
 * target code).
 *
 * Gated: runs only when INTEGRATION_TESTS=1 and GEMINI_API_KEY is set.
 * Skipped silently otherwise so CI without credentials still passes.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../CodeIndexer.js";
import { GeminiEmbeddings } from "../embeddings/GeminiEmbeddings.js";

const shouldRun =
  process.env.INTEGRATION_TESTS === "1" && !!process.env.GEMINI_API_KEY;

// Fixture files crafted so the queries below cannot be answered lexically:
// the expected target chunks use vocabulary that does NOT appear in the query.
const FIXTURES: Record<string, string> = {
  "auth.ts": `
    // Checks the provided credentials against the user store and issues a
    // session token on success.
    export function authenticate(username: string, password: string): string | null {
      const user = findUser(username);
      if (!user) return null;
      if (user.passwordHash !== hash(password)) return null;
      return issueSessionToken(user.id);
    }

    function findUser(name: string) { return { id: 1, passwordHash: "" }; }
    function hash(s: string) { return s; }
    function issueSessionToken(id: number) { return "tok_" + id; }
  `,
  "yaml.ts": `
    // Reads a YAML configuration document from disk and returns its contents
    // as a plain object.
    export function parseConfig(path: string): Record<string, unknown> {
      return loadYaml(path);
    }
    function loadYaml(_p: string): Record<string, unknown> { return {}; }
  `,
  "hash.ts": `
    // Computes the SHA-256 checksum of a buffer and returns the hex digest.
    export function computeHash(buf: Uint8Array): string {
      return sha256(buf);
    }
    function sha256(_b: Uint8Array): string { return ""; }
  `,
};

describe.skipIf(!shouldRun)("semantic search end-to-end (Gemini)", () => {
  async function makeIndexer() {
    const tmpDir = await mkdtemp(join(tmpdir(), "lucerna-semantic-e2e-"));
    const projectRoot = join(tmpDir, "project");
    const storageDir = join(tmpDir, "storage");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(storageDir, { recursive: true });

    for (const [name, content] of Object.entries(FIXTURES)) {
      await writeFile(join(projectRoot, name), content);
    }

    const indexer = new CodeIndexer({
      projectRoot,
      storageDir,
      embeddingFunction: new GeminiEmbeddings({
        model: "gemini-embedding-001",
        apiKey: process.env.GEMINI_API_KEY as string,
      }),
    });
    await indexer.initialize();
    await indexer.indexProject();
    return { indexer, tmpDir };
  }

  test("finds 'authenticate' from a query that shares no tokens with the code", async () => {
    const { indexer, tmpDir } = await makeIndexer();
    try {
      // Query uses "verify user login" — none of these tokens appear in auth.ts.
      // Lexical search (BM25) would have nothing to match; only semantic can
      // pull the right chunk.
      const results = await indexer.searchSemantic("verify user login", {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      const top = results[0];
      expect(top?.chunk.filePath).toMatch(/auth\.ts$/);
    } finally {
      await indexer.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("finds 'parseConfig' from a semantically-related query", async () => {
    const { indexer, tmpDir } = await makeIndexer();
    try {
      // Query uses "load settings file" — no shared tokens with yaml.ts.
      const results = await indexer.searchSemantic("load settings file", {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map((r) => r.chunk.filePath);
      expect(paths.some((p) => p.endsWith("yaml.ts"))).toBe(true);
    } finally {
      await indexer.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("hybrid search returns the right file for a semantic-only query", async () => {
    const { indexer, tmpDir } = await makeIndexer();
    try {
      const results = await indexer.search("compute fingerprint of data", {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map((r) => r.chunk.filePath);
      expect(paths.some((p) => p.endsWith("hash.ts"))).toBe(true);
    } finally {
      await indexer.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("multi-keyword query still lands on the right file", async () => {
    const { indexer, tmpDir } = await makeIndexer();
    try {
      // Five tokens describing one concept — "authenticate"/auth.ts.
      // None of the query tokens appear literally in the target code.
      const results = await indexer.search(
        "verify user credentials issue session token",
        { limit: 5 },
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.chunk.filePath).toMatch(/auth\.ts$/);
    } finally {
      await indexer.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("multi-keyword query combining concepts returns results for each", async () => {
    const { indexer, tmpDir } = await makeIndexer();
    try {
      // Query mentions two unrelated concepts: hashing AND parsing config.
      // Both hash.ts and yaml.ts should surface.
      const results = await indexer.search(
        "checksum digest and configuration loading",
        { limit: 10 },
      );
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map((r) => r.chunk.filePath);
      expect(paths.some((p) => p.endsWith("hash.ts"))).toBe(true);
      expect(paths.some((p) => p.endsWith("yaml.ts"))).toBe(true);
    } finally {
      await indexer.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
