import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type {
  EmbeddingFunction,
  LucernaConfig,
  RerankingFunction,
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
 * Loads `lucerna.config.ts` / `lucerna.config.js` from the project root (or
 * an explicit path). Uses jiti for on-the-fly TypeScript transpilation.
 *
 * Returns an empty object when no config file is found.
 */
export async function loadConfig(
  projectRoot: string,
  configPath?: string,
): Promise<LucernaConfig> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);

  const candidates = configPath
    ? [resolve(configPath)]
    : CONFIG_FILENAMES.map((f) => join(projectRoot, f));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = (await jiti.import(candidate)) as
        | { default?: unknown }
        | undefined;
      if (mod?.default && typeof mod.default === "object") {
        return mod.default as LucernaConfig;
      }
      throw new Error(
        `Config file ${candidate} must export a default object (LucernaConfig).`,
      );
    } catch (err) {
      // Re-throw errors from config files that exist but failed to load.
      // MODULE_NOT_FOUND just means the file wasn't found despite existsSync
      // finding it (race condition / symlink edge case) — skip silently.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
        throw err;
      }
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// Built-in provider resolvers (for --embedder / --reranker CLI flags)
// ---------------------------------------------------------------------------

const VALID_EMBEDDERS = [
  "cloudflare",
  "local",
  "hf",
  "bge-small",
  "jina-code",
  "nomic-text",
  "gemma",
] as const;
const VALID_RERANKERS = ["cloudflare", "jina", "voyage"] as const;

export type BuiltinEmbedder = (typeof VALID_EMBEDDERS)[number];
export type BuiltinReranker = (typeof VALID_RERANKERS)[number];

/**
 * Resolves a named built-in embedder to an `EmbeddingFunction` instance.
 * Credentials are read from environment variables, matching the same auto-detect
 * logic used when no embedder is specified.
 */
export async function resolveBuiltinEmbedder(
  name: string,
): Promise<EmbeddingFunction> {
  switch (name as BuiltinEmbedder) {
    case "cloudflare": {
      const { CloudflareEmbeddings } = await import(
        "./embeddings/CloudflareEmbeddings.js"
      );
      return new CloudflareEmbeddings();
    }
    case "local":
    case "hf": {
      const { HFEmbeddings } = await import("./embeddings/HFEmbeddings.js");
      return new HFEmbeddings();
    }
    case "bge-small": {
      const { BGESmallEmbeddings } = await import(
        "./embeddings/BGESmallEmbeddings.js"
      );
      return new BGESmallEmbeddings();
    }
    case "jina-code": {
      const { JinaCodeEmbeddings } = await import(
        "./embeddings/JinaCodeEmbeddings.js"
      );
      return new JinaCodeEmbeddings();
    }
    case "nomic-text": {
      const { NomicTextEmbeddings } = await import(
        "./embeddings/NomicTextEmbeddings.js"
      );
      return new NomicTextEmbeddings();
    }
    case "gemma": {
      const { GemmaEmbeddings } = await import(
        "./embeddings/GemmaEmbeddings.js"
      );
      return new GemmaEmbeddings();
    }
    default:
      throw new Error(
        `Unknown embedder: "${name}". Valid values: ${VALID_EMBEDDERS.join(", ")}`,
      );
  }
}

/**
 * Resolves a named built-in reranker to a `RerankingFunction` instance.
 * Credentials are read from environment variables.
 */
export async function resolveBuiltinReranker(
  name: string,
): Promise<RerankingFunction> {
  switch (name as BuiltinReranker) {
    case "cloudflare": {
      const { CloudflareReranker } = await import(
        "./embeddings/CloudflareReranker.js"
      );
      return new CloudflareReranker();
    }
    case "jina": {
      const { JinaReranker } = await import("./embeddings/JinaReranker.js");
      return new JinaReranker();
    }
    case "voyage": {
      const { VoyageReranker } = await import("./embeddings/VoyageReranker.js");
      return new VoyageReranker();
    }
    default:
      throw new Error(
        `Unknown reranker: "${name}". Valid values: ${VALID_RERANKERS.join(", ")}`,
      );
  }
}
