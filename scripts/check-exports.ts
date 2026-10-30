// Checks that every `exports` entry of the published packages resolves and loads
// in Node.js both as ESM (`import()`) and as CJS (`require()`), that both formats expose
// the same named exports and that the declared type files exist.
//
// Usage: node scripts/check-exports.ts (after `pnpm build`)
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["primer", "dynamite", "fuse", "detcord", "detonator"];

// the consumer packages resolving the exports (the templates depend on every published package)
const consumers: Record<string, string> = {
  detcord: path.join(root, "templates", "app-react-router"),
  detonator: path.join(root, "templates", "app-react-router"),
};
const defaultConsumer = path.join(root, "templates", "storefront-react-router");

type Conditions = { types: string; default: string };
type ExportEntry = { import: Conditions; require: Conditions };

let failures = 0;

function fail(message: string): void {
  failures++;
  console.error("FAIL " + message);
}

for (const dir of packages) {
  const pkgDir = path.join(root, "packages", dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));

  // resolve as a consumer would (a package that depends on it)
  const consumerDir = consumers[dir] || defaultConsumer;
  const consumer = createRequire(path.join(consumerDir, "package.json"));

  for (const [subpath, entry] of Object.entries(
    pkg.exports as Record<string, ExportEntry | string>,
  )) {
    if (typeof entry === "string") {
      continue; // ./package.json
    }

    const specifier = pkg.name + subpath.substring(1);
    const failuresBefore = failures;

    // CommonJS only entries (e.g. the TypeScript plugin loaded by tsserver with require())
    if (!("import" in entry)) {
      const cjsOnly = entry as unknown as { types: string; default: string };
      try {
        const loaded = consumer(specifier);
        if (!fs.existsSync(path.join(pkgDir, cjsOnly.types))) {
          fail(specifier + ": missing " + cjsOnly.types);
        }
        console.log(
          `${failures > failuresBefore ? "FAIL " : "ok   "}${specifier}: CJS only (${typeof loaded})`,
        );
      } catch (err) {
        fail(specifier + ": require() failed: " + err);
      }
      continue;
    }

    for (const file of [
      entry.import.types,
      entry.import.default,
      entry.require.types,
      entry.require.default,
    ]) {
      if (!fs.existsSync(path.join(pkgDir, file))) {
        fail(specifier + ": missing " + file);
      }
    }

    let cjsKeys: Array<string> = [];
    try {
      const resolved = consumer.resolve(specifier);
      if (!resolved.endsWith(entry.require.default.substring(1))) {
        fail(specifier + ": require resolved to " + resolved);
      }
      cjsKeys = Object.keys(consumer(specifier)).toSorted();
    } catch (err) {
      fail(specifier + ": require() failed: " + err);
    }

    // ESM: a separate Node.js process resolving from the consumer package
    let esmKeys: Array<string> = [];
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(specifier)});
           console.log(JSON.stringify({ resolved: import.meta.resolve(${JSON.stringify(specifier)}), keys: Object.keys(m).sort() }));`,
        ],
        { cwd: consumerDir, encoding: "utf8" },
      );
      const result = JSON.parse(out.trim().split("\n").pop()!);
      if (!result.resolved.endsWith(entry.import.default.substring(1))) {
        fail(specifier + ": import resolved to " + result.resolved);
      }
      esmKeys = result.keys;
    } catch (err) {
      fail(specifier + ": import() failed: " + err);
    }

    if (!esmKeys.length) {
      fail(specifier + ": no ESM exports");
    }
    if (JSON.stringify(esmKeys) !== JSON.stringify(cjsKeys)) {
      fail(specifier + ": ESM and CJS named exports differ");
    }

    console.log(
      `${failures > failuresBefore ? "FAIL " : "ok   "}${specifier}: ESM ${esmKeys.length} / CJS ${cjsKeys.length} named exports`,
    );
  }
}

if (failures) {
  console.error(failures + " export check(s) failed");
  process.exit(1);
}
