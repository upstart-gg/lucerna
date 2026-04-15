import { resolve } from "node:path";
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import type { IndexEvent } from "../types.js";

export interface WatcherOptions {
  projectRoot: string;
  include: string[];
  exclude: string[];
  debounce: number;
  onAdd: (filePath: string) => Promise<void>;
  onChange: (filePath: string) => Promise<void>;
  onRemove: (filePath: string) => Promise<void>;
  onEvent?: (event: IndexEvent) => void;
}

/**
 * File system watcher backed by chokidar.
 * Debounces rapid successive changes to the same file.
 */
export class Watcher {
  private watcher: FSWatcher | null = null;
  private readonly options: WatcherOptions;
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: WatcherOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.watcher) return;

    const { projectRoot, include, exclude, debounce } = this.options;

    const ignoredPatterns = exclude.map((pattern) => {
      // Convert glob to chokidar-compatible ignore
      if (!pattern.startsWith("/") && !pattern.startsWith("!")) {
        return `**/${pattern}`;
      }
      return pattern;
    });

    this.watcher = chokidar.watch(include, {
      cwd: projectRoot,
      ignored: [/node_modules/, /\.git/, ...ignoredPatterns],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: debounce,
        pollInterval: 100,
      },
    });

    this.watcher
      .on("add", (relativePath: string) => {
        const absPath = resolve(projectRoot, relativePath);
        this.debounce(absPath, () => this.options.onAdd(absPath));
      })
      .on("change", (relativePath: string) => {
        const absPath = resolve(projectRoot, relativePath);
        this.debounce(absPath, () => this.options.onChange(absPath));
      })
      .on("unlink", (relativePath: string) => {
        const absPath = resolve(projectRoot, relativePath);
        this.debounce(absPath, () => this.options.onRemove(absPath));
      });
  }

  async stop(): Promise<void> {
    // Cancel all pending debounce timers
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private debounce(key: string, fn: () => Promise<void>): void {
    const existing = this.pendingTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.pendingTimers.delete(key);
      try {
        await fn();
      } catch (err) {
        this.options.onEvent?.({
          type: "error",
          filePath: key,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }, this.options.debounce);

    this.pendingTimers.set(key, timer);
  }
}
