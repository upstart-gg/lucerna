import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as clack from "@clack/prompts";

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

  const argv: [string, string[]] = (() => {
    const suffix = isWin ? ".cmd" : "";
    switch (pm) {
      case "pnpm":
        return [`pnpm${suffix}`, ["add", "--save-dev", pkg]];
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
// Provider metadata
// ---------------------------------------------------------------------------

type Provider =
  | "voyage"
  | "openai"
  | "cohere"
  | "jina"
  | "mistral"
  | "gemini"
  | "ollama"
  | "lmstudio"
  | "skip";

interface ProviderMeta {
  label: string;
  envVar?: string;
  model: string;
  extraFields?: string;
  hint?: string;
}

const PROVIDERS: Record<Provider, ProviderMeta> = {
  voyage: {
    label: "Voyage AI (recommended for code)",
    envVar: "VOYAGE_API_KEY",
    model: "voyage-code-3",
    hint: "Get a key at https://dash.voyageai.com",
  },
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    model: "text-embedding-3-small",
  },
  cohere: {
    label: "Cohere",
    envVar: "COHERE_API_KEY",
    model: "embed-english-v3.0",
  },
  jina: {
    label: "Jina AI",
    envVar: "JINA_API_KEY",
    model: "jina-embeddings-v3",
  },
  mistral: {
    label: "Mistral AI",
    envVar: "MISTRAL_API_KEY",
    model: "mistral-embed",
  },
  gemini: {
    label: "Google Gemini",
    envVar: "GOOGLE_API_KEY",
    model: "text-embedding-004",
  },
  ollama: {
    label: "Ollama (local, no API key needed)",
    model: "nomic-embed-text",
  },
  lmstudio: {
    label: "LM Studio (local, no API key needed)",
    model: "text-embedding-nomic-embed-text-v1.5",
  },
  skip: {
    label: "Skip — BM25 lexical search only",
    model: "",
  },
};

// ---------------------------------------------------------------------------
// Config file generation
// ---------------------------------------------------------------------------

function buildConfigContent(provider: Provider): string {
  if (provider === "skip") {
    return `import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({});
`;
  }

  const meta = PROVIDERS[provider];

  if (provider === "ollama") {
    return `import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({
  embedding: { provider: "ollama", model: "${meta.model}" },
});
`;
  }

  if (provider === "lmstudio") {
    return `import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({
  embedding: { provider: "lmstudio", model: "${meta.model}" },
});
`;
  }

  const envVar = meta.envVar ?? "API_KEY";
  return `import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({
  embedding: { provider: "${provider}", model: "${meta.model}", apiKey: process.env.${envVar}! },
});
`;
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

  // --- Step 2: Embedding provider ---
  const providerKey = await clack.select<Provider>({
    message: "Enable semantic (vector) search?",
    options: (Object.entries(PROVIDERS) as [Provider, ProviderMeta][]).map(
      ([value, meta]) => ({
        value,
        label: meta.label,
      }),
    ),
    initialValue: "voyage" as Provider,
  });

  if (clack.isCancel(providerKey)) {
    clack.cancel("Setup cancelled.");
    process.exit(0);
  }

  // --- Step 3: API key ---
  let apiKey: string | undefined;
  const meta = PROVIDERS[providerKey];

  if (
    providerKey !== "skip" &&
    providerKey !== "ollama" &&
    providerKey !== "lmstudio"
  ) {
    if (meta.hint) {
      clack.note(meta.hint, `${meta.label} API key`);
    }

    const key = await clack.password({
      message: `Enter your ${meta.label} API key:`,
      validate: (v) =>
        !v || v.trim().length === 0 ? "API key cannot be empty." : undefined,
    });

    if (clack.isCancel(key)) {
      clack.cancel("Setup cancelled.");
      process.exit(0);
    }

    apiKey = key as string;
  }

  // --- Step 4: Write config file ---
  const cwd = process.cwd();
  const configPath = join(cwd, "lucerna.config.ts");

  if (providerKey !== "skip") {
    // Install @upstart.gg/lucerna as a dev dep so the config's `defineConfig`
    // import resolves for TypeScript — but only if a package.json exists.
    if (existsSync(join(cwd, "package.json"))) {
      const s = clack.spinner();
      s.start(`Installing @upstart.gg/lucerna as a dev dependency…`);
      const ok = installDevDep("@upstart.gg/lucerna@latest", cwd);
      s.stop(
        ok
          ? "Installed @upstart.gg/lucerna."
          : "Install failed — run it manually.",
      );
    }
    if (existsSync(configPath)) {
      const overwrite = await clack.confirm({
        message: "lucerna.config.ts already exists. Overwrite?",
        initialValue: false,
      });
      if (clack.isCancel(overwrite) || !overwrite) {
        clack.note("Skipped — existing config file unchanged.", "Config");
      } else {
        await writeFile(configPath, buildConfigContent(providerKey), "utf-8");
        clack.note(`Written: ${configPath}`, "Config");
      }
    } else {
      await writeFile(configPath, buildConfigContent(providerKey), "utf-8");
      clack.note(`Written: ${configPath}`, "Config");
    }
  }

  // Remind user to set the env var
  if (apiKey && meta.envVar) {
    clack.note(
      `Add this to your shell profile so your AI client can read it:\n\nexport ${meta.envVar}=${apiKey}`,
      "Environment variable",
    );
  }

  // --- Step 5: .gitignore ---
  await ensureGitignore(cwd);

  clack.outro(
    "Done! Restart your AI client to load the Lucerna MCP server.\nDocs: https://lucerna.upstart.gg",
  );
}
