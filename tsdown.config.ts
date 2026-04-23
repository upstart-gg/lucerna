import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    configure: "src/configure.ts",
    cli: "src/cli/index.ts",
    mcp: "src/mcp/server.ts",
  },
  format: ["esm"],
  dts: true,
  platform: "node",
  treeshake: true,
  sourcemap: true,
});
