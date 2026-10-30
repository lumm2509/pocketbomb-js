// The `dynamite` CLI (Node.js only): codegen, dev, info.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Fuse } from "@pocketbomb/fuse/node";
import {
  codegen,
  DEFAULT_ENV_FILE,
  DEFAULT_SCHEMA_FILE,
  watchCodegen,
  type GenerateResult,
} from "./codegen";

const HELP = `dynamite <command> [options]

Commands:
  codegen   Introspect the PocketBomb GraphQL API and write the schema + the gql.tada env
            --url <url>            (default $POCKETBOMB_URL)
            --public-key <key>     (default $POCKETBOMB_PUBLIC_KEY)
            --schema <file>        (default ${DEFAULT_SCHEMA_FILE})
            --env <file>           (default ${DEFAULT_ENV_FILE})
            --watch [--interval <ms>]
            --fuse [--seed <module>]  start a local server with fuse for the codegen
  dev       Start fuse (unless $POCKETBOMB_URL is set), the codegen watcher and the app
            --seed <module>  --data-dir <dir>
            --entry <file>   run a custom server entry with Node.js (default: the Vite dev server)
            --port <port>    the Vite dev server port
  info      Print the PocketBomb environment and the generated files status
`;

type Io = { log: (line: string) => void; error: (line: string) => void };

const defaultIo: Io = {
  log: (line) => process.stdout.write(line + "\n"),
  error: (line) => process.stderr.write(line + "\n"),
};

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

async function startFuseFromFlags(
  flags: { seed?: string; "data-dir"?: string },
  io: Io,
): Promise<Fuse> {
  const { startFuse } = await import("@pocketbomb/fuse/node");
  const fuse = await startFuse({
    seed: flags.seed,
    dataDir: flags["data-dir"],
    log: (line) => io.error("[fuse] " + line),
  });
  Object.assign(process.env, fuse.env);
  io.error("[fuse] PocketBomb running on " + fuse.url);
  return fuse;
}

function describeResult(result: GenerateResult, cwd: string): string {
  return (
    (result.changed ? "generated " : "up to date: ") +
    path.relative(cwd, result.schemaFile) +
    ", " +
    path.relative(cwd, result.envFile)
  );
}

async function runCodegen(argv: Array<string>, io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      "public-key": { type: "string" },
      schema: { type: "string" },
      env: { type: "string" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      fuse: { type: "boolean" },
      seed: { type: "string" },
      cwd: { type: "string" },
    },
  });

  const cwd = path.resolve(values.cwd || process.cwd());
  const fuse = values.fuse ? await startFuseFromFlags(values, io) : null;

  try {
    const url = values.url || process.env.POCKETBOMB_URL;
    if (!url) {
      io.error("dynamite codegen: missing --url (or $POCKETBOMB_URL)");
      return 2;
    }

    const options = {
      url,
      publicKey: values["public-key"] || process.env.POCKETBOMB_PUBLIC_KEY,
      cwd,
      schemaFile: values.schema,
      envFile: values.env,
    };

    if (!values.watch) {
      io.log(describeResult(await codegen(options), cwd));
      return 0;
    }

    const stop = watchCodegen({
      ...options,
      interval: values.interval ? parseInt(values.interval, 10) : undefined,
      onChange: (result) => io.log(describeResult(result, cwd)),
      onError: (err) => io.error("codegen: " + String((err as Error)?.message || err)),
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    stop();
    return 0;
  } finally {
    await fuse?.stop();
  }
}

async function runDev(argv: Array<string>, io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: "string" },
      "data-dir": { type: "string" },
      entry: { type: "string" },
      port: { type: "string" },
      "no-codegen": { type: "boolean" },
    },
  });

  const cwd = process.cwd();
  const fuse = process.env.POCKETBOMB_URL ? null : await startFuseFromFlags(values, io);

  let stopCodegen = () => {};
  if (!values["no-codegen"] && process.env.POCKETBOMB_PUBLIC_KEY) {
    stopCodegen = watchCodegen({
      url: process.env.POCKETBOMB_URL!,
      publicKey: process.env.POCKETBOMB_PUBLIC_KEY,
      cwd,
      onChange: (result) => io.error("[codegen] " + describeResult(result, cwd)),
      onError: (err) => io.error("[codegen] " + String((err as Error)?.message || err)),
    });
  }

  const cleanup = async () => {
    stopCodegen();
    await fuse?.stop();
  };

  if (values.entry) {
    const child = spawn(process.execPath, [path.resolve(cwd, values.entry)], {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" },
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    const code: number = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    await cleanup();
    return code;
  }

  const { createServer } = await import("vite");
  const server = await createServer({
    root: cwd,
    server: values.port ? { port: parseInt(values.port, 10) } : undefined,
  });
  await server.listen();
  server.printUrls();

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  await cleanup();
  return 0;
}

async function runInfo(io: Io): Promise<number> {
  const cwd = process.cwd();
  const mask = (v?: string) => (v ? v.substring(0, 6) + "…" : "(not set)");

  io.log("@pocketbomb/dynamite " + readPackageVersion());
  io.log("node " + process.version);
  io.log("POCKETBOMB_URL         " + (process.env.POCKETBOMB_URL || "(not set)"));
  io.log("POCKETBOMB_PUBLIC_KEY  " + mask(process.env.POCKETBOMB_PUBLIC_KEY));
  io.log("POCKETBOMB_PRIVATE_KEY " + (process.env.POCKETBOMB_PRIVATE_KEY ? "(set)" : "(not set)"));

  for (const file of [DEFAULT_SCHEMA_FILE, DEFAULT_ENV_FILE]) {
    const full = path.resolve(cwd, file);
    io.log(
      file.padEnd(23) +
        (fs.existsSync(full) ? "generated " + fs.statSync(full).mtime.toISOString() : "missing"),
    );
  }

  try {
    const { resolveFuseBinary } = await import("@pocketbomb/fuse/node");
    const resolved = resolveFuseBinary({ log: () => {} });
    io.log("fuse binary            " + resolved.bin + " (" + resolved.source + ")");
  } catch (err) {
    io.log("fuse binary            " + String((err as Error).message));
  }

  return 0;
}

/**
 * Runs the CLI with the provided arguments (without the node and script paths).
 */
export async function run(argv: Array<string>, io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "codegen":
      return runCodegen(rest, io);
    case "dev":
      return runDev(rest, io);
    case "info":
      return runInfo(io);
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

export * from "./codegen";
