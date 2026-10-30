// Versioning and release of the published packages with changesets.
//
//   node scripts/release.ts version   # apply the pending changesets (versions + CHANGELOG.md)
//   node scripts/release.ts publish   # full check (format, lint, typecheck, tests, build, exports)
//                                     # then `changeset publish` (add --dry-run to stop before it)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: Array<string>): void {
  console.log("$ " + [command, ...args].join(" "));
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

const [action, ...flags] = process.argv.slice(2);

switch (action) {
  case "version":
    run("pnpm", ["exec", "changeset", "version"]);
    // keep the lockfile in sync with the bumped workspace versions
    run("pnpm", ["install", "--lockfile-only"]);
    break;
  case "publish":
    run("pnpm", ["run", "format:check"]);
    run("pnpm", ["run", "lint"]);
    run("pnpm", ["run", "build"]);
    run("pnpm", ["run", "typecheck"]);
    run("pnpm", ["run", "test"]);
    run("node", ["scripts/check-exports.ts"]);
    if (flags.includes("--dry-run")) {
      console.log("dry run: skipped `changeset publish`");
    } else {
      run("pnpm", ["exec", "changeset", "publish"]);
    }
    break;
  default:
    console.error("usage: node scripts/release.ts <version|publish> [--dry-run]");
    process.exit(2);
}
