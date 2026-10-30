import { defineConfig } from "tsdown";

const outExtensions = ({ format }: { format: string }) =>
  format === "cjs" ? { js: ".cjs", dts: ".d.cts" } : { js: ".js", dts: ".d.ts" };

export default defineConfig([
  // ESM (.js + .d.ts) and CJS (.cjs + .d.cts) builds of the dynamite entries.
  // The output is unbundled (one file per module) so that the entries share the same modules;
  // the dependencies and the peers (react, vite) are external.
  {
    entry: [
      "src/index.ts",
      "src/customer-account/index.ts",
      "src/graphql/index.ts",
      "src/react/index.ts",
      "src/vite/index.ts",
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
    outExtensions,
  },
  // the TypeScript plugin is loaded by tsserver with require() (module.exports = the factory)
  {
    entry: { "ts-plugin/index": "src/ts-plugin/index.ts" },
    format: ["cjs"],
    platform: "node",
    target: "es2022",
    dts: true,
    sourcemap: true,
    hash: false,
    clean: false,
    cjsDefault: true,
    outExtensions,
  },
]);
