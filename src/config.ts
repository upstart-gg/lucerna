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
  "openai",
  "cohere",
  "voyage",
  "jina",
  "cloudflare",
  "mistral",
  "gemini",
  "ollama",
  "vertex",
] as const;

const VALID_RERANKERS = [
  "cloudflare",
  "jina",
  "voyage",
  "cohere",
  "vertex",
  "gemini",
] as const;

export type BuiltinEmbedder = (typeof VALID_EMBEDDERS)[number];
export type BuiltinReranker = (typeof VALID_RERANKERS)[number];

/**
 * Parses a "provider:model" or "provider:model:dimensions" string.
 * Both provider and model are required; dimensions is an optional positive integer.
 */
function parseProviderModel(
  value: string,
  source: string,
): { provider: string; model: string; dimensions?: number } {
  const firstColon = value.indexOf(":");
  const provider = firstColon === -1 ? value : value.slice(0, firstColon);
  const rest = firstColon === -1 ? "" : value.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  const model = secondColon === -1 ? rest : rest.slice(0, secondColon);
  const dimStr = secondColon === -1 ? undefined : rest.slice(secondColon + 1);

  if (!provider || !model) {
    throw new Error(
      `${source} requires "provider:model" format (e.g. "voyage:voyage-code-3"), got: "${value}"`,
    );
  }

  let dimensions: number | undefined;
  if (dimStr !== undefined) {
    dimensions = parseInt(dimStr, 10);
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
      throw new Error(
        `${source}: dimensions must be a positive integer, got: "${dimStr}"`,
      );
    }
  }

  return dimensions !== undefined
    ? { provider, model, dimensions }
    : { provider, model };
}

/**
 * Resolves a "provider:model" flag value to an `EmbeddingFunction` instance.
 */
export async function resolveBuiltinEmbedder(
  flagValue: string,
): Promise<EmbeddingFunction> {
  const { provider, model, dimensions } = parseProviderModel(
    flagValue,
    "--embedder",
  );
  const d = dimensions !== undefined ? { dimensions } : {};
  switch (provider as BuiltinEmbedder) {
    case "openai": {
      const { OpenAIEmbeddings } = await import(
        "./embeddings/OpenAIEmbeddings.js"
      );
      return new OpenAIEmbeddings({ model, ...d });
    }
    case "cohere": {
      const { CohereEmbeddings } = await import(
        "./embeddings/CohereEmbeddings.js"
      );
      return new CohereEmbeddings({ model, ...d });
    }
    case "voyage": {
      const { VoyageEmbeddings } = await import(
        "./embeddings/VoyageEmbeddings.js"
      );
      return new VoyageEmbeddings({ model, ...d });
    }
    case "jina": {
      const { JinaEmbeddings } = await import("./embeddings/JinaEmbeddings.js");
      return new JinaEmbeddings({ model, ...d });
    }
    case "cloudflare": {
      const { CloudflareEmbeddings } = await import(
        "./embeddings/CloudflareEmbeddings.js"
      );
      return new CloudflareEmbeddings({ model, ...d });
    }
    case "mistral": {
      const { MistralEmbeddings } = await import(
        "./embeddings/MistralEmbeddings.js"
      );
      return new MistralEmbeddings({ model, ...d });
    }
    case "gemini": {
      const { GeminiEmbeddings } = await import(
        "./embeddings/GeminiEmbeddings.js"
      );
      return new GeminiEmbeddings({ model, ...d });
    }
    case "ollama": {
      const { OllamaEmbeddings } = await import(
        "./embeddings/OllamaEmbeddings.js"
      );
      return new OllamaEmbeddings({ model, ...d });
    }
    case "vertex": {
      const { VertexAIEmbeddings } = await import(
        "./embeddings/VertexAIEmbeddings.js"
      );
      return new VertexAIEmbeddings({ model, ...d });
    }
    default:
      throw new Error(
        `Unknown embedder provider: "${provider}". Valid providers: ${VALID_EMBEDDERS.join(", ")}`,
      );
  }
}

/**
 * Resolves a "provider:model" flag value to a `RerankingFunction` instance.
 */
export async function resolveBuiltinReranker(
  flagValue: string,
): Promise<RerankingFunction> {
  const { provider, model } = parseProviderModel(flagValue, "--reranker");
  switch (provider as BuiltinReranker) {
    case "cloudflare": {
      const { CloudflareReranker } = await import(
        "./embeddings/CloudflareReranker.js"
      );
      return new CloudflareReranker({ model });
    }
    case "jina": {
      const { JinaReranker } = await import("./embeddings/JinaReranker.js");
      return new JinaReranker(undefined, model);
    }
    case "voyage": {
      const { VoyageReranker } = await import("./embeddings/VoyageReranker.js");
      return new VoyageReranker(undefined, model);
    }
    case "cohere": {
      const { CohereReranker } = await import("./embeddings/CohereReranker.js");
      return new CohereReranker({ model });
    }
    case "vertex": {
      const { VertexAIReranker } = await import(
        "./embeddings/VertexAIReranker.js"
      );
      return new VertexAIReranker({ model });
    }
    case "gemini": {
      const { GeminiReranker } = await import("./embeddings/GeminiReranker.js");
      return new GeminiReranker({ model });
    }
    default:
      throw new Error(
        `Unknown reranker provider: "${provider}". Valid providers: ${VALID_RERANKERS.join(", ")}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Env-var resolution (LUCERNA_EMBEDDING / LUCERNA_RERANKING)
// ---------------------------------------------------------------------------

/**
 * Resolves the `LUCERNA_EMBEDDING` environment variable to an embedding function.
 * The value must be in "provider:model" format (e.g. "voyage:voyage-code-3").
 * Returns `false` if the variable is not set.
 */
export async function resolveEmbedderFromEnv(): Promise<
  EmbeddingFunction | false
> {
  const val = process.env.LUCERNA_EMBEDDING;
  if (!val) return false;
  const { provider, model } = parseProviderModel(val, "LUCERNA_EMBEDDING");
  // Re-use the same resolver but inject the parsed provider:model
  return resolveBuiltinEmbedder(`${provider}:${model}`);
}

/**
 * Resolves the `LUCERNA_RERANKING` environment variable to a reranking function.
 * The value must be in "provider:model" format (e.g. "cohere:rerank-english-v3.0").
 * Returns `false` if the variable is not set.
 */
export async function resolveRerankerFromEnv(): Promise<
  RerankingFunction | false
> {
  const val = process.env.LUCERNA_RERANKING;
  if (!val) return false;
  const { provider, model } = parseProviderModel(val, "LUCERNA_RERANKING");
  return resolveBuiltinReranker(`${provider}:${model}`);
}
