/**
 * Library logger. Always writes to stderr so stdout stays clean for
 * machine-readable output (e.g. CLI `--format json`).
 *
 * Library code must never use `console.log` directly — stdout is the
 * program's data channel and is owned by the caller (CLI or host app).
 */

export const log = {
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
};
