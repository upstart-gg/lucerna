/**
 * Tests for the leader/follower locking behavior of CodeIndexer.
 * Uses a short leaderPollMs to keep tests fast.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../CodeIndexer.js";

const POLL_MS = 50;

let tmpDir: string;
let projectRoot: string;
let storageDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lucerna-leader-test-"));
  projectRoot = join(tmpDir, "project");
  storageDir = join(tmpDir, "storage");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    join(projectRoot, "hello.ts"),
    "export function hello(): string { return 'hello'; }",
  );
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeIndexer(): CodeIndexer {
  return new CodeIndexer({
    projectRoot,
    storageDir,
    embeddingFunction: false,
    leaderPollMs: POLL_MS,
  });
}

describe("leader/follower locking", () => {
  test("first indexer to initialize becomes the leader", async () => {
    const indexer = makeIndexer();
    await indexer.initialize();
    expect(indexer.isLeader).toBe(true);
    await indexer.close();
  });

  test("second indexer initialized against same storageDir becomes a follower", async () => {
    const leader = makeIndexer();
    const follower = makeIndexer();
    await leader.initialize();
    await follower.initialize();
    expect(leader.isLeader).toBe(true);
    expect(follower.isLeader).toBe(false);
    await leader.close();
    await follower.close();
  });

  test("leader indexProject() indexes files; follower indexProject() returns zeros", async () => {
    const leader = makeIndexer();
    const follower = makeIndexer();
    await leader.initialize();
    await follower.initialize();

    const leaderStats = await leader.indexProject();
    const followerStats = await follower.indexProject();

    expect(leaderStats.totalFiles).toBeGreaterThan(0);
    expect(leaderStats.totalChunks).toBeGreaterThan(0);
    expect(followerStats.totalFiles).toBe(0);
    expect(followerStats.totalChunks).toBe(0);

    await leader.close();
    await follower.close();
  });

  test("follower can still search the index built by the leader", async () => {
    const leader = makeIndexer();
    const follower = makeIndexer();
    await leader.initialize();
    await leader.indexProject();
    await follower.initialize();

    const results = await follower.search("hello");
    expect(results.length).toBeGreaterThan(0);

    await leader.close();
    await follower.close();
  });

  test("follower claims leadership after leader closes", async () => {
    const leader = makeIndexer();
    const follower = makeIndexer();
    await leader.initialize();
    await leader.indexProject();
    await follower.initialize();
    expect(follower.isLeader).toBe(false);

    // Start follower watching — this starts the leadership poll
    await follower.startWatching();

    // Close leader, releasing the lock
    await leader.close();

    // Wait long enough for the poll interval to fire and claim leadership
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS * 5));

    expect(follower.isLeader).toBe(true);
    await follower.close();
  });

  test("after leadership transfer, new leader can index", async () => {
    const leader = makeIndexer();
    const follower = makeIndexer();
    await leader.initialize();
    await leader.indexProject();
    await follower.initialize();
    await follower.startWatching();

    await leader.close();
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS * 5));

    expect(follower.isLeader).toBe(true);

    // Add a new file after leadership transfer
    await writeFile(
      join(projectRoot, "world.ts"),
      "export function world(): string { return 'world'; }",
    );

    const stats = await follower.indexProject();
    expect(stats.totalFiles).toBeGreaterThan(0);

    await follower.close();
  });
});
