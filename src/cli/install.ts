import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as clack from "@clack/prompts";
import { createDefaultConfig } from "../config.js";
import type { VectorStoreBackend } from "../store/factory.js";

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function detectPackageManager(): PackageManager {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

function installDevDep(pkg: string, cwd: string): boolean {
  const pm = detectPackageManager();
  const isWin = process.platform === "win32";

  const isPnpmWorkspaceRoot =
    pm === "pnpm" && existsSync(join(cwd, "pnpm-workspace.yaml"));

  const argv: [string, string[]] = (() => {
    const suffix = isWin ? ".cmd" : "";
    switch (pm) {
      case "pnpm":
        return [
          `pnpm${suffix}`,
          ["add", "--save-dev", ...(isPnpmWorkspaceRoot ? ["-w"] : []), pkg],
        ];
      case "yarn":
        return [`yarn${suffix}`, ["add", "--dev", pkg]];
      case "bun":
        return [`bun${suffix}`, ["add", "--dev", pkg]];
      default:
        return [`npm${suffix}`, ["install", "--save-dev", pkg]];
    }
  })();

  const result = spawnSync(argv[0], argv[1], { stdio: "inherit", cwd });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureGitignore(dir: string): Promise<void> {
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (content.includes(".lucerna")) return;
    await appendFile(gitignorePath, "\n# Lucerna index\n.lucerna/\n");
  } else {
    await writeFile(gitignorePath, "# Lucerna index\n.lucerna/\n");
  }
}

function runAddMcp(): boolean {
  // On Windows, npx is a .cmd file and requires the .cmd suffix when shell is not used.
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    npx,
    [
      "-y",
      "add-mcp",
      "npx -y @upstart.gg/lucerna@latest mcp-server",
      "--name",
      "lucerna",
      "--yes",
    ],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

const BACKEND_PACKAGES: Record<VectorStoreBackend, string[]> = {
  lancedb: ["@lancedb/lancedb@^0.27.2"],
  sqlite: ["better-sqlite3@^11", "sqlite-vec@^0.1"],
};

export async function runInstall(): Promise<void> {
  clack.intro("Lucerna setup");

  // --- Step 1: Register MCP server ---
  const s1 = clack.spinner();
  s1.start("Registering Lucerna MCP server with your AI clients…");
  const mcpOk = runAddMcp();
  if (mcpOk) {
    s1.stop("MCP server registered.");
  } else {
    s1.stop("add-mcp reported an error — you may need to register manually.");
  }

  // --- Step 2: Pick vector-store backend ---
  const backendChoice = await clack.select<VectorStoreBackend>({
    message: "Which vector store do you want to use?",
    options: [
      {
        value: "sqlite",
        label: "SQLite + sqlite-vec",
        hint: "default, single-file, easy to inspect with the sqlite3 CLI",
      },
      {
        value: "lancedb",
        label: "LanceDB",
        hint: "faster for very large repos, native binary",
      },
    ],
    initialValue: "sqlite",
  });
  if (clack.isCancel(backendChoice)) {
    clack.cancel("Setup cancelled.");
    return;
  }
  const backend = backendChoice;

  // --- Step 3: Config file + dependencies ---
  const cwd = process.cwd();
  const configPath = join(cwd, "lucerna.config.ts");

  if (existsSync(configPath)) {
    clack.note("lucerna.config.ts already exists — skipped.", "Config");
  } else {
    if (existsSync(join(cwd, "package.json"))) {
      const s = clack.spinner();
      s.start("Installing @upstart.gg/lucerna as a dev dependency…");
      const ok = installDevDep("@upstart.gg/lucerna@latest", cwd);
      s.stop(
        ok
          ? "Installed @upstart.gg/lucerna."
          : "Install failed — run it manually.",
      );

      for (const pkg of BACKEND_PACKAGES[backend]) {
        const depSpinner = clack.spinner();
        depSpinner.start(`Installing ${pkg}…`);
        const depOk = installDevDep(pkg, cwd);
        depSpinner.stop(
          depOk
            ? `Installed ${pkg}.`
            : `Install of ${pkg} failed — run it manually.`,
        );
      }
    }
    await createDefaultConfig(cwd, { vectorStore: backend });
    clack.note(
      "Created lucerna.config.ts — edit it to configure your embedding provider.",
      "Config",
    );
  }

  // --- Step 4: .gitignore ---
  await ensureGitignore(cwd);

  clack.outro(
    "Done! Restart your AI client to load the Lucerna MCP server.\nDocs: https://lucerna.upstart.gg",
  );
}
