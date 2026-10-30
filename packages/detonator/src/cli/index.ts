// The `detonator` CLI (Node.js only): dev, deploy, info.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  deployManifest,
  loadManifest,
  resolveManifest,
  scopesToPermissions,
  updateEnvFile,
  type AppManifest,
} from "./manifest";

export * from "./manifest";

const HELP = `detonator <command> [options]

Commands:
  dev       Start fuse, import pocketbomb.app.toml as a custom app, run the app and install it
            --config <file>   (default pocketbomb.app.toml)
            --seed <module>   the fuse seed (e.g. the collections of the scopes)
            --entry <file>    the app server entry run with Node.js (default server.ts)
            --port <port>     the app port (default a free port)
            --dotenv <file>   the env file to update (default .env)
  deploy    Deploy (import) the manifest to a PocketBomb instance
            --url <url> --token <staff access token> [--config <file>] [--app-url <url>]
  info      Print the manifest summary and the environment
`;

type Io = { log: (line: string) => void; error: (line: string) => void };

const defaultIo: Io = {
  log: (line) => process.stdout.write(line + "\n"),
  error: (line) => process.stderr.write(line + "\n"),
};

function readPackageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      .version;
  } catch {
    return "unknown";
  }
}

async function waitForApp(url: string, child: ChildProcess, timeout = 60000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("The app exited early (code " + child.exitCode + ").");
    }
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) {
        return;
      }
    } catch {
      // not listening yet
    }
    // poll interval of the app startup readiness check
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("The app didn't start in " + timeout + "ms.");
}

export interface DevOptions {
  cwd?: string;
  config?: string;
  seed?: string;
  entry?: string;
  port?: number;
  envFile?: string;
  io?: Io;
  /** Called once the app is installed (the CLI waits for the app process otherwise). */
  onReady?: (state: DevState) => void | Promise<void>;
}

export interface DevState {
  pocketbombUrl: string;
  appUrl: string;
  issuer: string;
  installationId: string;
  applicationId: string;
  notified: boolean;
  app: ChildProcess;
  owner: { email: string; password: string };
  stop(): Promise<void>;
}

/**
 * `detonator dev`: fuse -> import the manifest (with the dev app URL) as a custom application ->
 * run the app -> install it with the manifest scopes (the credentials are delivered to the running
 * app install_url, or written to the env file for a manifest without install_url).
 */
export async function dev(options: DevOptions = {}): Promise<DevState> {
  const io = options.io || defaultIo;
  const cwd = path.resolve(options.cwd || process.cwd());
  const manifestFile = path.resolve(cwd, options.config || "pocketbomb.app.toml");
  const envFile = path.resolve(cwd, options.envFile || ".env");
  const entry = path.resolve(cwd, options.entry || "server.ts");

  const { freePort, signInStaff, startFuse } = await import("pocketbomb-fuse/node");

  const port = options.port || (await freePort("localhost"));
  const appUrl = "http://localhost:" + port;
  const manifest = resolveManifest(loadManifest(manifestFile), appUrl);

  const fuse = await startFuse({
    seed: options.seed ? path.resolve(cwd, options.seed) : undefined,
    log: (line) => io.error("[fuse] " + line),
  });
  io.error("[detonator] PocketBomb (fuse) running on " + fuse.url);

  let app: ChildProcess | null = null;
  const stop = async () => {
    if (app && app.exitCode === null) {
      const exited = new Promise((r) => app!.once("exit", r));
      app.kill("SIGTERM");
      await exited;
    }
    await fuse.stop();
  };

  try {
    const owner = await signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);
    // the dev app (and its webhooks) are on a loopback host
    await owner.settings.update({
      meta: { appURL: fuse.url },
      webhooks: { allowPrivateTargets: true },
    });

    const imported = await owner.applications.importManifest(manifest as any, "json");
    io.error("[detonator] imported " + manifest.handle + " " + imported.version.version);

    const collections = await owner.collections.getFullList({ fields: "id,name" });
    const permissions = scopesToPermissions(manifest.access?.scopes || [], collections);
    const issuer = fuse.url + "/oauth2/_applicationInstallations";

    const baseEnv: Record<string, string> = {
      ...fuse.env,
      POCKETBOMB_URL: fuse.url,
      POCKETBOMB_ISSUER: issuer,
      POCKETBOMB_APP_HANDLE: manifest.handle,
      APP_URL: appUrl,
      PORT: String(port),
    };

    const startApp = async (env: Record<string, string>) => {
      app = spawn(process.execPath, [entry], {
        cwd,
        stdio: "inherit",
        env: { ...process.env, ...env, NODE_ENV: process.env.NODE_ENV || "development" },
      });
      await waitForApp(appUrl + "/", app);
      io.error("[detonator] app running on " + appUrl);
    };

    let installed;
    let envValues: Record<string, string>;
    if (manifest.install_url) {
      // the credentials are delivered to the running app (install notification)
      await startApp(baseEnv);
      installed = await owner.applications.install(imported.application.id, permissions as any);
      envValues = { ...baseEnv, POCKETBOMB_INSTALLATION_ID: installed.installation.id };
    } else {
      // a custom app without install_url gets the credentials once: env file + app env
      installed = await owner.applications.install(imported.application.id, permissions as any);
      envValues = {
        ...baseEnv,
        POCKETBOMB_INSTALLATION_ID: installed.installation.id,
        POCKETBOMB_CLIENT_ID: installed.clientId,
        POCKETBOMB_CLIENT_SECRET: installed.clientSecret,
        POCKETBOMB_WEBHOOK_SECRET: installed.webhookSecret,
      };
      await startApp(envValues);
    }

    updateEnvFile(envFile, envValues);
    io.error(
      "[detonator] installed " +
        manifest.handle +
        " (installation " +
        installed.installation.id +
        (installed.notified
          ? ", credentials delivered to the install_url"
          : ", credentials in " + path.basename(envFile)) +
        ")",
    );

    const state: DevState = {
      pocketbombUrl: fuse.url,
      appUrl,
      issuer,
      installationId: installed.installation.id,
      applicationId: imported.application.id,
      notified: installed.notified,
      app: app!,
      owner: fuse.owner,
      stop,
    };

    await options.onReady?.(state);

    return state;
  } catch (err) {
    await stop();
    throw err;
  }
}

async function runDev(argv: Array<string>, io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      seed: { type: "string" },
      entry: { type: "string" },
      port: { type: "string" },
      dotenv: { type: "string" },
    },
  });

  const state = await dev({
    config: values.config,
    seed: values.seed,
    entry: values.entry,
    port: values.port ? parseInt(values.port, 10) : undefined,
    envFile: values.dotenv,
    io,
  });
  io.log(
    "Dashboard: " +
      state.pocketbombUrl +
      "/_/  (" +
      state.owner.email +
      " / " +
      state.owner.password +
      ")",
  );
  io.log("App:       " + state.appUrl);

  const code: number = await new Promise((resolve) => {
    state.app.once("exit", (c) => resolve(c ?? 0));
    const shutdown = () => void state.stop().then(() => resolve(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await state.stop();
  return code;
}

async function runDeploy(argv: Array<string>, io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      config: { type: "string" },
      "app-url": { type: "string" },
    },
  });

  const url = values.url || process.env.POCKETBOMB_URL;
  const token = values.token || process.env.POCKETBOMB_TOKEN;
  if (!url || !token) {
    io.error(
      "detonator deploy: --url and --token are required (or $POCKETBOMB_URL / $POCKETBOMB_TOKEN)",
    );
    return 2;
  }

  const manifest = resolveManifest(
    loadManifest(path.resolve(values.config || "pocketbomb.app.toml")),
    values["app-url"],
  );

  const result = await deployManifest({ url, token, manifest });
  io.log(
    (result.created ? "created " : result.unchanged ? "unchanged " : "new version of ") +
      manifest.handle +
      " " +
      (result.version?.version || "") +
      " (application " +
      result.application?.id +
      ")",
  );
  return 0;
}

function runInfo(argv: Array<string>, io: Io): number {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" } } });
  const file = path.resolve(values.config || "pocketbomb.app.toml");

  io.log("pocketbomb-detonator " + readPackageVersion());
  io.log("node " + process.version);

  let manifest: AppManifest;
  try {
    manifest = loadManifest(file);
  } catch (err) {
    io.log("manifest               " + String((err as Error).message));
    return 1;
  }

  io.log("manifest               " + path.basename(file));
  io.log("handle                 " + manifest.handle + " " + (manifest.version || ""));
  io.log("application_url        " + (manifest.application_url || "(not set)"));
  io.log("scopes                 " + (manifest.access?.scopes || []).join(", "));
  io.log(
    "webhooks               " +
      (manifest.webhooks?.subscriptions || [])
        .map((s) => s.topics.join(",") + " -> " + s.uri)
        .join("; "),
  );
  io.log(
    "extensions             " +
      (manifest.extensions || []).map((e) => e.type + ":" + e.handle + " " + e.path).join("; "),
  );
  io.log("POCKETBOMB_URL         " + (process.env.POCKETBOMB_URL || "(not set)"));
  io.log(
    "POCKETBOMB_CLIENT_SECRET " + (process.env.POCKETBOMB_CLIENT_SECRET ? "(set)" : "(not set)"),
  );
  return 0;
}

/**
 * Runs the CLI with the provided arguments (without the node and script paths).
 */
export async function run(argv: Array<string>, io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "dev":
      return runDev(rest, io);
    case "deploy":
      return runDeploy(rest, io);
    case "info":
      return runInfo(rest, io);
    case "--version":
    case "-v":
      io.log(readPackageVersion());
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.log(HELP);
      return 0;
    default:
      io.error("Unknown command: " + command + "\n\n" + HELP);
      return 2;
  }
}
