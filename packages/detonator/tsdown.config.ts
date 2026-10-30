import { defineConfig } from "tsdown";

// ESM (.js + .d.ts) and CJS (.cjs + .d.cts) builds of the detonator entries (unbundled: the
// entries share the same modules; the dependencies and react are external).
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server/index.ts",
    "src/react/index.tsx",
    "src/adapters/node/index.ts",
    "src/session-storage/index.ts",
    "src/cli/index.ts",
  ],
  format: ["esm", "cjs"],
  platform: "neutral",
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
