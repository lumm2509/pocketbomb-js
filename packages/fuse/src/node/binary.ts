import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolveBinaryOptions {
  /**
   * A prebuilt PocketBomb server binary (default to $POCKETBOMB_BIN).
   */
  bin?: string;

  /**
   * The PocketBomb Go repository to build `./examples/base` from (default to $POCKETBOMB_SRC).
   */
  src?: string;

  /**
   * The build cache dir (default to $POCKETBOMB_FUSE_CACHE or ~/.cache/pocketbomb-fuse).
   */
  cacheDir?: string;

  /**
   * Build output logger (default to stderr).
   */
  log?: (line: string) => void;
}

export interface ResolvedBinary {
  bin: string;

  /**
   * How the binary was resolved.
   */
  source: "bin" | "env" | "cache" | "build";

  /**
   * The source hash of a built binary.
   */
  hash?: string;
}

// directories never relevant for the Go build of examples/base
const IGNORED_DIRS = new Set([".git", "node_modules", ".tmp", ".turbo", ".cache"]);

function walk(dir: string, root: string, files: Array<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith("pb_data")) {
        walk(path.join(dir, entry.name), root, files);
      }
      continue;
    }

    const rel = path.relative(root, path.join(dir, entry.name));
    const isGo = entry.name.endsWith(".go") || entry.name === "go.mod" || entry.name === "go.sum";
    // the dashboard is embedded in the binary (ui/embed.go)
    const isEmbedded = rel.split(path.sep)[0] === "ui" && rel.split(path.sep)[1] === "dist";
    if (isGo || isEmbedded) {
      files.push(rel);
    }
  }
}

/**
 * Returns the SHA-256 hash of the PocketBomb Go sources relevant for the server build
 * (the .go files, go.mod/go.sum and the embedded dashboard `ui/dist`).
 */
export function sourceHash(src: string): string {
  const files: Array<string> = [];
  walk(src, src, files);
  files.sort();

  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(src, rel)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function defaultCacheDir(): string {
  return process.env.POCKETBOMB_FUSE_CACHE || path.join(os.homedir(), ".cache", "pocketbomb-fuse");
}

/**
 * Resolves the PocketBomb server binary: `bin` / $POCKETBOMB_BIN, otherwise it is built
 * from `src` / $POCKETBOMB_SRC with `go build ./examples/base` (cached by the source hash).
 *
 * @throws {Error} when there is neither a binary nor a source repository (there are no
 * downloadable releases yet).
 */
export function resolveFuseBinary(options: ResolveBinaryOptions = {}): ResolvedBinary {
  const log = options.log || ((line: string) => process.stderr.write("[fuse] " + line + "\n"));

  const explicit = options.bin || process.env.POCKETBOMB_BIN;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error("The PocketBomb binary " + explicit + " doesn't exist.");
    }
    return { bin: path.resolve(explicit), source: options.bin ? "bin" : "env" };
  }

  const src = options.src || process.env.POCKETBOMB_SRC;
  if (!src) {
    throw new Error(
      "Fuse can't find a PocketBomb server: pass `bin` (or set POCKETBOMB_BIN) to a server binary " +
        "or `src` (or set POCKETBOMB_SRC) to the PocketBomb Go repository to build it " +
        "(there are no downloadable releases yet).",
    );
  }

  const repo = path.resolve(src);
  if (!fs.existsSync(path.join(repo, "examples", "base"))) {
    throw new Error("The PocketBomb repository " + repo + " has no examples/base to build.");
  }

  const hash = sourceHash(repo);
  const dir = path.join(options.cacheDir || defaultCacheDir(), hash.substring(0, 32));
  const bin = path.join(dir, process.platform === "win32" ? "pocketbomb.exe" : "pocketbomb");

  if (fs.existsSync(bin)) {
    return { bin, source: "cache", hash };
  }

  fs.mkdirSync(dir, { recursive: true });

  // build into a unique file and rename it (concurrent builds of the same hash are safe)
  const tmp = bin + "." + process.pid + "." + Date.now() + ".tmp";
  log(
    "building " + path.join(repo, "examples/base") + " (source " + hash.substring(0, 12) + ")...",
  );
  try {
    execFileSync("go", ["build", "-o", tmp, "./examples/base"], { cwd: repo, stdio: "inherit" });
    fs.renameSync(tmp, bin);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  return { bin, source: "build", hash };
}
