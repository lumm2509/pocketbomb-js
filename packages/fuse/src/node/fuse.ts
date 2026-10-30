import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFuseBinary, type ResolveBinaryOptions } from "./binary";
import { signInStaff } from "./owner";
import type { DashboardClient } from "@pocketbomb/primer/internal";

/**
 * The Owner superuser created by fuse on every start (`superuser upsert`).
 */
export const FUSE_OWNER = { email: "owner@example.com", password: "OwnerPass123456" };

export interface FuseSeedContext {
  /** The server URL. */
  url: string;
  /** The Owner credentials. */
  owner: { email: string; password: string };
  /** Signs in the Owner with the dashboard client (hosted login driven headlessly). */
  signInOwner(): Promise<DashboardClient>;
}

/**
 * Seeds a fresh data dir and returns the variables exposed as `env` (e.g. the API keys).
 */
export type FuseSeed = (
  context: FuseSeedContext,
) => Promise<Record<string, string> | void> | Record<string, string> | void;

export interface FuseOptions extends ResolveBinaryOptions {
  /**
   * A persistent data dir (default to a temporary one removed on stop).
   * The seed runs only once per data dir (its env is stored in `<dataDir>/fuse-seed.json`).
   */
  dataDir?: string;

  /**
   * The port (default to a free one) and host (default to 127.0.0.1).
   */
  port?: number;
  host?: string;

  /**
   * The seed function or a module path whose default export is the seed function.
   */
  seed?: FuseSeed | string;

  /**
   * Keep the temporary data dir on stop (default to $POCKETBOMB_FUSE_KEEP).
   */
  keep?: boolean;

  /**
   * The server start timeout in ms (default to 60000).
   */
  timeout?: number;
}

export interface Fuse {
  url: string;
  port: number;
  dataDir: string;
  bin: string;
  owner: { email: string; password: string };

  /**
   * The seed env (plus POCKETBOMB_URL).
   */
  env: Record<string, string>;

  /**
   * The server output so far.
   */
  logs(): string;

  stop(): Promise<void>;
}

export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(
  url: string,
  server: ChildProcess,
  timeout: number,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error("The PocketBomb server exited early:\n" + logs());
    }

    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) {
        return;
      }
    } catch {
      // not listening yet
    }

    // poll interval of the startup health check
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("The PocketBomb server didn't become healthy in " + timeout + "ms:\n" + logs());
}

async function loadSeed(seed: FuseSeed | string): Promise<FuseSeed> {
  if (typeof seed === "function") {
    return seed;
  }

  const mod = await import(pathToFileURL(path.resolve(seed)).href);
  const fn = mod.default || mod.seed;
  if (typeof fn !== "function") {
    throw new Error("The fuse seed module " + seed + " has no default export function.");
  }

  return fn;
}

/**
 * Starts a local PocketBomb server (the mini-oxygen equivalent): it resolves (or builds) the
 * binary, creates the Owner superuser, runs `serve --dev` with a temporary (or the provided)
 * data dir and the optional seed.
 */
export async function startFuse(options: FuseOptions = {}): Promise<Fuse> {
  const { bin } = resolveFuseBinary(options);
  const keep = options.keep ?? !!process.env.POCKETBOMB_FUSE_KEEP;

  const tmpDir = options.dataDir ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "pocketbomb-fuse-"));
  const dataDir = path.resolve(options.dataDir || path.join(tmpDir, "pb_data"));
  const baseDir = path.dirname(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const seedFile = path.join(dataDir, "fuse-seed.json");
  const alreadySeeded = fs.existsSync(seedFile);

  // the CLI created superusers are Owners
  execFileSync(
    bin,
    ["superuser", "upsert", FUSE_OWNER.email, FUSE_OWNER.password, "--dir", dataDir],
    {
      stdio: "pipe",
    },
  );

  const host = options.host || "127.0.0.1";
  const port = options.port || (await freePort(host));
  const url = "http://" + host + ":" + port;

  let output = "";
  const server = spawn(
    bin,
    [
      "serve",
      "--dev",
      "--http=" + host + ":" + port,
      "--dir=" + dataDir,
      "--migrationsDir=" + path.join(baseDir, "pb_migrations"),
      "--hooksDir=" + path.join(baseDir, "pb_hooks"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    // keep the last 1MB
    if (output.length > 1 << 20) {
      output = output.substring(output.length - (1 << 20));
    }
  };
  server.stdout!.on("data", capture);
  server.stderr!.on("data", capture);

  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill("SIGTERM");
      await exited;
    }

    if (tmpDir && !keep) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  try {
    await waitHealthy(url, server, options.timeout || 60000, () => output);

    let env: Record<string, string> = {};
    if (alreadySeeded) {
      env = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    } else if (options.seed) {
      const seed = await loadSeed(options.seed);
      env =
        (await seed({
          url,
          owner: { ...FUSE_OWNER },
          signInOwner: () => signInStaff(url, FUSE_OWNER.email, FUSE_OWNER.password),
        })) || {};
      fs.writeFileSync(seedFile, JSON.stringify(env, null, 2));
    }

    return {
      url,
      port,
      dataDir,
      bin,
      owner: { ...FUSE_OWNER },
      env: { ...env, POCKETBOMB_URL: url },
      logs: () => output,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
