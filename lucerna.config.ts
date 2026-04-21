import { defineConfig } from "@upstart.gg/lucerna";

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
  exclude: ["**/docs/**", "**/bin/**", "**/examples/**"],
  embedding: {
    provider: "gemini",
    "model": "gemini-embedding-001",
    apiKey: process.env.GEMINI_API_KEY as string,
  }
});
