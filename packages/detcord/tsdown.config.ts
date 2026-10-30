import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
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
