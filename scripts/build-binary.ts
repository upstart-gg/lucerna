/**
 * Build a standalone lucerna binary for the current platform.
 *
 * Usage:
 *   bun scripts/build-binary.ts
 *
 * The binary is written to bin/lucerna-{platform}, e.g.:
 *   bin/lucerna-darwin-arm64
 *   bin/lucerna-linux-x64
 *   bin/lucerna-windows-x64.exe
 *
 * Note: --bytecode is intentionally omitted. It causes a runtime crash with
 * the current dependency set (mixed CJS/ESM modules from native addons).
 * Track: https://github.com/oven-sh/bun/issues if/when this is resolved.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const PLATFORM = process.platform; // darwin | linux | win32
const ARCH = process.arch; // arm64 | x64

type BunTarget =
  | "bun-darwin-arm64"
  | "bun-darwin-x64"
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64-musl"
  | "bun-linux-arm64-musl"
  | "bun-windows-x64";

interface TargetInfo {
  target: BunTarget;
  binary: string;
}

function resolveTarget(): TargetInfo {
  if (PLATFORM === "darwin") {
    if (ARCH === "arm64")
      return { target: "bun-darwin-arm64", binary: "lucerna-darwin-arm64" };
    if (ARCH === "x64")
      return { target: "bun-darwin-x64", binary: "lucerna-darwin-x64" };
  }
  if (PLATFORM === "linux") {
    if (ARCH === "x64")
      return { target: "bun-linux-x64", binary: "lucerna-linux-x64" };
    if (ARCH === "arm64")
      return { target: "bun-linux-arm64", binary: "lucerna-linux-arm64" };
  }
  if (PLATFORM === "win32") {
    if (ARCH === "x64")
      return {
        target: "bun-windows-x64",
        binary: "lucerna-windows-x64.exe",
      };
  }
  console.error(
    `Unsupported platform/arch: ${PLATFORM}/${ARCH}\n` +
      `Supported: darwin/arm64, darwin/x64, linux/x64, linux/arm64, win32/x64`,
  );
  process.exit(1);
}

const { target, binary } = resolveTarget();
const outDir = join(import.meta.dir, "..", "bin");
const outFile = join(outDir, binary);

await mkdir(outDir, { recursive: true });

// Remove stale binary so a failed build doesn't leave a broken artifact
try {
  await rm(outFile, { force: true });
} catch {
  // ignore
}

console.log(`Building ${binary} (target: ${target})…`);

const proc = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    "src/cli/index.ts",
    `--target=${target}`,
    `--outfile=${outFile}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (proc.exitCode !== 0) {
  console.error(`Build failed (exit ${proc.exitCode})`);
  process.exit(proc.exitCode ?? 1);
}

console.log(`✓  ${outFile}`);
