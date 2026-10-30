import { defineConfig } from "tsdown";

// ESM (.js + .d.ts) and CJS (.cjs + .d.cts) builds of the fuse entries (Node.js only).
// The output is unbundled (one file per module) so that the entries share the same modules;
// pocketbomb-primer and vite are external.
export default defineConfig({
  entry: ["src/node/index.ts", "src/vite/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "es2022",
  dts: true,
  unbundle: true,
  root: "src",
  sourcemap: true,
  hash: false,
  clean: true,
  outExtensions: ({ format }) =>
    format === "cjs" ? { js: ".cjs", dts: ".d.cts" } : { js: ".js", dts: ".d.ts" },
});
