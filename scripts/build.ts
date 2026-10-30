// Builds the published packages (turbo + tsdown: ESM .js/.d.ts and CJS .cjs/.d.cts per entry)
// and verifies that every `exports` entry loads in Node.js as ESM and CJS (scripts/check-exports.ts).
//
// Usage: node scripts/build.ts [--all]   (--all also builds the examples)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: Array<string>): void {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

const all = process.argv.includes("--all");

run("pnpm", ["exec", "turbo", "run", "build", ...(all ? [] : ["--filter=./packages/*"])]);
run(process.execPath, [path.join(root, "scripts", "check-exports.ts")]);
