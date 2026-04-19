import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type {
  EmbeddingFunction,
  EmbeddingProviderConfig,
  LucernaConfig,
  RerankingFunction,
  RerankingProviderConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

const CONFIG_FILENAMES = [
  "lucerna.config.ts",
  "lucerna.config.js",
  "lucerna.config.mjs",
];

/**
 * Loads `lucerna.config.ts` / `lucerna.config.js` by walking up the directory
 * tree from `projectRoot`. Returns the first config found, or an empty object
 * if none exists anywhere in the tree.
 */
export async function loadConfig(
  projectRoot: string,
): Promise<{ config: LucernaConfig; configDir: string | null }> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);

  const candidates: Array<{ path: string; dir: string }> = (() => {
    const results: Array<{ path: string; dir: string }> = [];
    let dir = projectRoot;
    while (true) {
      for (const filename of CONFIG_FILENAMES) {
        results.push({ path: join(dir, filename), dir });
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return results;
  })();

  for (const { path: candidate, dir } of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = (await jiti.import(candidate)) as
        | { default?: unknown }
        | undefined;
      if (mod?.default && typeof mod.default === "object") {
        return { config: mod.default as LucernaConfig, configDir: dir };
      }
      throw new Error(
        `Config file ${candidate} must export a default object (LucernaConfig).`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
        throw err;
      }
    }
  }

  return { config: {}, configDir: null };
}

// ---------------------------------------------------------------------------
// Auto-create default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_TEMPLATE = `import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({
  // Configure a semantic search provider (required for semantic/vector search):
  // embedding: { provider: "voyage", model: "voyage-code-3", apiKey: "sk-..." },
  // embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-..." },
  // embedding: { provider: "ollama", model: "nomic-embed-text" },

  // Configure a reranker (optional, improves result ranking):
  // reranking: { provider: "voyage", apiKey: "sk-..." },

  // Restrict which files are indexed (default: all files):
  // include: ["src/**/*"],

  // Add extra exclusion patterns (node_modules, .git etc. are always excluded):
  // exclude: ["**/*.test.ts", "**/fixtures/**"],
});
`;

/**
 * Creates a `lucerna.config.ts` template in the given directory.
 * Logs a message to stderr so it doesn't interfere with MCP stdio.
 */
export async function createDefaultConfig(dir: string): Promise<void> {
  const path = join(dir, "lucerna.config.ts");
  await writeFile(path, DEFAULT_CONFIG_TEMPLATE, "utf-8");
  process.stderr.write(
    `[lucerna] Created ${path} — edit it to configure your embedding provider.\n`,
  );
}

// ---------------------------------------------------------------------------
// Provider config resolvers
// ---------------------------------------------------------------------------

function isEmbeddingProviderConfig(
  val: EmbeddingProviderConfig | EmbeddingFunction,
): val is EmbeddingProviderConfig {
  return (
    "provider" in val &&
    typeof (val as EmbeddingProviderConfig).provider === "string"
  );
}

function isRerankingProviderConfig(
  val: RerankingProviderConfig | RerankingFunction,
): val is RerankingProviderConfig {
  return (
    "provider" in val &&
    typeof (val as RerankingProviderConfig).provider === "string"
  );
}

/**
 * Resolves `LucernaConfig.embedding` to an `EmbeddingFunction` instance.
 * Handles provider config objects, existing instances, `false`, and `undefined`.
 */
export async function resolveEmbeddingConfig(
  cfg: EmbeddingProviderConfig | EmbeddingFunction | false | undefined,
): Promise<EmbeddingFunction | false | undefined> {
  if (cfg === undefined || cfg === false) return cfg;
  if (!isEmbeddingProviderConfig(cfg)) return cfg as EmbeddingFunction;

  const d = cfg.dimensions !== undefined ? { dimensions: cfg.dimensions } : {};

  switch (cfg.provider) {
    case "voyage": {
      const { VoyageEmbeddings } = await import(
        "./embeddings/VoyageEmbeddings.js"
      );
      return new VoyageEmbeddings({
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...d,
      });
    }
    case "openai": {
      const { OpenAIEmbeddings } = await import(
        "./embeddings/OpenAIEmbeddings.js"
      );
      return new OpenAIEmbeddings({
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...d,
      });
    }
    case "cohere": {
      const { CohereEmbeddings } = await import(
        "./embeddings/CohereEmbeddings.js"
      );
      return new CohereEmbeddings({
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...d,
      });
    }
    case "jina": {
      const { JinaEmbeddings } = await import("./embeddings/JinaEmbeddings.js");
      return new JinaEmbeddings({ model: cfg.model, apiKey: cfg.apiKey, ...d });
    }
    case "mistral": {
      const { MistralEmbeddings } = await import(
        "./embeddings/MistralEmbeddings.js"
      );
      return new MistralEmbeddings({
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...d,
      });
    }
    case "gemini": {
      const { GeminiEmbeddings } = await import(
        "./embeddings/GeminiEmbeddings.js"
      );
      return new GeminiEmbeddings({
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...d,
      });
    }
    case "ollama": {
      const { OllamaEmbeddings } = await import(
        "./embeddings/OllamaEmbeddings.js"
      );
      return new OllamaEmbeddings({
        model: cfg.model,
        ...(cfg.host !== undefined ? { host: cfg.host } : {}),
        ...d,
      });
    }
    case "lmstudio": {
      const { LMStudioEmbeddings } = await import(
        "./embeddings/LMStudioEmbeddings.js"
      );
      return new LMStudioEmbeddings({
        model: cfg.model,
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
        ...d,
      });
    }
    case "cloudflare": {
      const { CloudflareEmbeddings } = await import(
        "./embeddings/CloudflareEmbeddings.js"
      );
      return new CloudflareEmbeddings({
        accountId: cfg.accountId,
        apiToken: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...d,
      });
    }
    case "vertex": {
      const { VertexAIEmbeddings } = await import(
        "./embeddings/VertexAIEmbeddings.js"
      );
      return new VertexAIEmbeddings({
        model: cfg.model,
        project: cfg.project,
        accessToken: cfg.accessToken,
        ...(cfg.location !== undefined ? { location: cfg.location } : {}),
        ...d,
      });
    }
    default: {
      const exhaustive: never = cfg;
      throw new Error(
        `Unknown embedding provider: "${(exhaustive as EmbeddingProviderConfig).provider}"`,
      );
    }
  }
}

/**
 * Resolves `LucernaConfig.reranking` to a `RerankingFunction` instance.
 * Handles provider config objects, existing instances, `false`, and `undefined`.
 */
export async function resolveRerankingConfig(
  cfg: RerankingProviderConfig | RerankingFunction | false | undefined,
): Promise<RerankingFunction | false | undefined> {
  if (cfg === undefined || cfg === false) return cfg;
  if (!isRerankingProviderConfig(cfg)) return cfg as RerankingFunction;

  switch (cfg.provider) {
    case "voyage": {
      const { VoyageReranker } = await import("./embeddings/VoyageReranker.js");
      return new VoyageReranker({
        apiKey: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    case "cohere": {
      const { CohereReranker } = await import("./embeddings/CohereReranker.js");
      return new CohereReranker({
        apiKey: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    case "jina": {
      const { JinaReranker } = await import("./embeddings/JinaReranker.js");
      return new JinaReranker({
        apiKey: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    case "gemini": {
      const { GeminiReranker } = await import("./embeddings/GeminiReranker.js");
      return new GeminiReranker({
        apiKey: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    case "cloudflare": {
      const { CloudflareReranker } = await import(
        "./embeddings/CloudflareReranker.js"
      );
      return new CloudflareReranker({
        accountId: cfg.accountId,
        apiToken: cfg.apiKey,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    case "vertex": {
      const { VertexAIReranker } = await import(
        "./embeddings/VertexAIReranker.js"
      );
      return new VertexAIReranker({
        project: cfg.project,
        accessToken: cfg.accessToken,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      });
    }
    default: {
      const exhaustive: never = cfg;
      throw new Error(
        `Unknown reranking provider: "${(exhaustive as RerankingProviderConfig).provider}"`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// defineConfig helper
// ---------------------------------------------------------------------------

/**
 * Helper for `lucerna.config.ts` — provides TypeScript autocomplete and
 * type-checking with no need to import the `LucernaConfig` type separately.
 *
 * @example
 * ```ts
 * // lucerna.config.ts
 * import { defineConfig } from "@upstart.gg/lucerna";
 *
 * export default defineConfig({
 *   embedding: { provider: "voyage", model: "voyage-code-3", apiKey: "sk-..." },
 * });
 * ```
 */
export function defineConfig(config: LucernaConfig): LucernaConfig {
  return config;
}
