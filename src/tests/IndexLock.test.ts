import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexLock } from "../IndexLock.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lucerna-lock-test-"));
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("IndexLock.tryAcquire", () => {
  test("succeeds when no lock file exists", async () => {
    const lock = new IndexLock(tmpDir);
    expect(await lock.tryAcquire()).toBe(true);
    expect(lock.isHeld).toBe(true);
  });

  test("writes current PID to lock file", async () => {
    const lock = new IndexLock(tmpDir);
    await lock.tryAcquire();
    const { pid } = JSON.parse(
      await readFile(join(tmpDir, "index.lock"), "utf8"),
    ) as { pid: number };
    expect(pid).toBe(process.pid);
  });

  test("fails when lock is already held by this process (simulates another live process)", async () => {
    const lock1 = new IndexLock(tmpDir);
    const lock2 = new IndexLock(tmpDir);
    expect(await lock1.tryAcquire()).toBe(true);
    // lock1 holds it — lock2 should be denied
    expect(await lock2.tryAcquire()).toBe(false);
    expect(lock2.isHeld).toBe(false);
  });

  test("clears stale lock from a dead PID and acquires", async () => {
    // Write a lock file with a PID that cannot possibly be running
    await writeFile(
      join(tmpDir, "index.lock"),
      JSON.stringify({ pid: 999_999_999 }),
    );
    const lock = new IndexLock(tmpDir);
    expect(await lock.tryAcquire()).toBe(true);
    expect(lock.isHeld).toBe(true);
  });

  test("respects a lock held by a live process (own PID)", async () => {
    // Write a lock file with our own PID — we're definitely alive
    await writeFile(
      join(tmpDir, "index.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    const lock = new IndexLock(tmpDir);
    expect(await lock.tryAcquire()).toBe(false);
  });

  test("succeeds again after release", async () => {
    const lock1 = new IndexLock(tmpDir);
    const lock2 = new IndexLock(tmpDir);
    await lock1.tryAcquire();
    await lock1.release();
    expect(await lock2.tryAcquire()).toBe(true);
  });

  test("handles malformed lock file conservatively", async () => {
    await writeFile(join(tmpDir, "index.lock"), "not json {{{");
    const lock = new IndexLock(tmpDir);
    // Should not throw, should just return false
    expect(await lock.tryAcquire()).toBe(false);
  });
});

describe("IndexLock.release", () => {
  test("deletes the lock file", async () => {
    const lock = new IndexLock(tmpDir);
    await lock.tryAcquire();
    await lock.release();
    expect(lock.isHeld).toBe(false);
    // File should be gone — second lock can now acquire
    const lock2 = new IndexLock(tmpDir);
    expect(await lock2.tryAcquire()).toBe(true);
  });

  test("is idempotent — calling release twice does not throw", async () => {
    const lock = new IndexLock(tmpDir);
    await lock.tryAcquire();
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  test("is a no-op when lock was never acquired", async () => {
    const lock = new IndexLock(tmpDir);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
