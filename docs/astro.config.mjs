import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://lucerna.upstart.gg",
  integrations: [
    starlight({
      title: "Lucerna",
      description: "AST-aware semantic + lexical code indexer for AI agents",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/upstart-gg/lucerna",
        },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", link: "/" },
            { label: "Quickstart", slug: "quickstart" },
          ],
        },
        {
          label: "Concepts",
          collapsed: true,
          items: [
            { label: "How It Works", slug: "concepts/how-it-works" },
            { label: "CodeChunk", slug: "concepts/code-chunk" },
            { label: "Search Modes", slug: "concepts/search-modes" },
            { label: "Knowledge Graph", slug: "concepts/knowledge-graph" },
            { label: "Language Support", slug: "concepts/language-support" },
          ],
        },
        {
          label: "Embeddings",
          collapsed: true,
          items: [
            { label: "Overview", slug: "embeddings/overview" },
            { label: "Local Models", slug: "embeddings/local" },
            { label: "Cloudflare", slug: "embeddings/cloudflare" },
            { label: "Custom", slug: "embeddings/custom" },
          ],
        },
        {
          label: "Reranking",
          collapsed: true,
          items: [{ label: "Overview", slug: "reranking/overview" }],
        },
        {
          label: "Programmatic Usage",
          collapsed: true,
          items: [
            { label: "Quick Start", slug: "programmatic-usage/quickstart" },
            {
              label: "Configuration",
              slug: "programmatic-usage/configuration",
            },
            { label: "Indexing", slug: "programmatic-usage/indexing" },
            { label: "Searching", slug: "programmatic-usage/searching" },
            {
              label: "Graph Traversal",
              slug: "programmatic-usage/graph-traversal",
            },
            { label: "File Watching", slug: "programmatic-usage/watching" },
            { label: "Inspection", slug: "programmatic-usage/inspection" },
            {
              label: "Integrations",
              collapsed: true,
              items: [
                { label: "Vercel AI SDK", slug: "integrations/vercel-ai-sdk" },
                { label: "Anthropic / Claude", slug: "integrations/anthropic" },
                {
                  label: "Multiple Projects",
                  slug: "integrations/multiple-projects",
                },
              ],
            },
          ],
        },
        {
          label: "CLI",
          collapsed: true,
          items: [
            { label: "Overview", slug: "cli/overview" },
            { label: "index", slug: "cli/index-command" },
            { label: "watch", slug: "cli/watch" },
            { label: "search", slug: "cli/search" },
            { label: "graph", slug: "cli/graph" },
            { label: "stats", slug: "cli/stats" },
            { label: "clear", slug: "cli/clear" },
            { label: "eval", slug: "cli/eval" },
          ],
        },
      ],
    }),
    mermaid(),
  ],
});
