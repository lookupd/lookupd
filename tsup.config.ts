import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
});
