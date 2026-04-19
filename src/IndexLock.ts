import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export class IndexLock {
  private readonly lockPath: string;
  private held = false;

  constructor(storageDir: string) {
    this.lockPath = join(storageDir, "index.lock");
  }

  /**
   * Try to acquire the indexing lock. Returns true if this process becomes
   * the leader (responsible for indexing and watching), false if another live
   * process already holds the lock.
   *
   * Uses O_EXCL atomic create to avoid races. If an existing lock contains a
   * dead PID, the stale file is removed and acquisition is retried once.
   */
  async tryAcquire(): Promise<boolean> {
    try {
      const fd = await open(this.lockPath, "wx");
      await fd.writeFile(JSON.stringify({ pid: process.pid }));
      await fd.close();
      this.held = true;
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    // Lock file exists — check whether the holder is still alive.
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const { pid } = JSON.parse(raw) as { pid: number };
      if (isAlive(pid)) return false;
      // Stale lock from a dead process — clean up and retry once.
      await rm(this.lockPath, { force: true });
      return this.tryAcquire();
    } catch {
      // Parse error or concurrent removal — be conservative.
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    await rm(this.lockPath, { force: true }).catch(() => {});
    this.held = false;
  }

  get isHeld(): boolean {
    return this.held;
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks process existence without sending a real signal.
    // Works on POSIX (Linux, macOS) and Node's libuv emulation on Windows.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: process exists but we lack permission to signal it — still alive.
    // On Windows, Node maps ERROR_ACCESS_DENIED to EPERM via libuv.
    if (code === "EPERM") return true;
    // ESRCH (POSIX) or ENOENT (Windows fallback): no such process.
    return false;
  }
}
