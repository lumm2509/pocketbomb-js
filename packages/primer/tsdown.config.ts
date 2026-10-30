import { defineConfig } from "tsdown";

// ESM (.js + .d.ts) and CJS (.cjs + .d.cts) builds of the public and the dashboard internal entry.
// The output is unbundled (one file per module) so that both entries share the same module
// instances (e.g. `DashboardClient extends Client` uses the same `Client` class).
export default defineConfig({
  entry: ["src/index.ts", "src/internal/index.ts"],
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
