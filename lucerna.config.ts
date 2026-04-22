import { defineConfig } from "@upstart.gg/lucerna";

export default defineConfig({
  // Add extra exclusion patterns (node_modules, .git etc. are always excluded):
  exclude: ["**/docs/**", "**/bin/**", "**/examples/**"],
  embedding: {
    provider: "gemini",
    "model": "gemini-embedding-001",
    apiKey: process.env.GEMINI_API_KEY as string,
  }
});
