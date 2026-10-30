// Starts a local PocketBomb server with fuse (@pocketbomb/fuse) for the monorepo
// (the integration suite and the examples smoke runs).
//
// CLI:
//   node scripts/pocketbomb-server.ts                  # start and keep running (Ctrl+C to stop)
//   node scripts/pocketbomb-server.ts --seed <module>  # + seed (default export of the module)
//   node scripts/pocketbomb-server.ts [--seed <module>] -- <cmd> [args]
//                                                      # run <cmd> with POCKETBOMB_URL, the Owner
//                                                      # credentials and the seed env, then stop
// Env:
//   POCKETBOMB_BIN   a prebuilt server binary
//   POCKETBOMB_SRC   the PocketBomb Go repository (default to ../pocketbase next to this monorepo)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFuse, type FuseOptions } from "@pocketbomb/fuse/node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The fuse options of the monorepo: $POCKETBOMB_BIN, $POCKETBOMB_SRC or the sibling
 * `../pocketbase` checkout.
 */
export function monorepoFuseOptions(options: FuseOptions = {}): FuseOptions {
  if (options.bin || options.src || process.env.POCKETBOMB_BIN || process.env.POCKETBOMB_SRC) {
    return options;
  }

  return { ...options, src: path.resolve(root, "..", "pocketbase") };
}

async function main(argv: Array<string>): Promise<number> {
  const sep = argv.indexOf("--");
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;

  const seedIdx = flags.indexOf("--seed");
  const seed = seedIdx >= 0 ? flags[seedIdx + 1] : undefined;
  if (seedIdx >= 0 && !seed) {
    throw new Error("--seed requires a module path");
  }

  const fuse = await startFuse(monorepoFuseOptions({ seed }));
  process.stderr.write("PocketBomb (fuse) running on " + fuse.url + "\n");

  const stopAndExit = async (code: number) => {
    await fuse.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void stopAndExit(130));
  process.on("SIGTERM", () => void stopAndExit(143));

  if (!command.length) {
    for (const key in fuse.env) {
      console.log(key + "=" + fuse.env[key]);
    }
    // keep running until interrupted
    await new Promise(() => {});
    return 0;
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      ...fuse.env,
      POCKETBOMB_OWNER_EMAIL: fuse.owner.email,
      POCKETBOMB_OWNER_PASSWORD: fuse.owner.password,
    },
  });
  const code: number = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));

  await fuse.stop();

  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
