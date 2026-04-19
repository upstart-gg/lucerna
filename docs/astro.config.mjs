import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://lucerna.upstart.gg",
  integrations: [
    starlight({
      title: "Lucerna", // Lucerna
      description: "AST-aware semantic + lexical code indexer for AI agents",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/upstart-gg/lucerna",
        },
      ],
      favicon: "/favicon.svg",
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
          label: "Configuration",
          collapsed: false,
          items: [
            { label: "Overview", slug: "configuration/overview" },
            {
              label: "Embedding Providers",
              slug: "configuration/embedding-providers",
            },
            {
              label: "Reranking Providers",
              slug: "configuration/reranking-providers",
            },
            { label: "Env Vars", slug: "configuration/env-vars" },
            {
              label: "Custom Providers",
              slug: "configuration/custom-providers",
            },
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
