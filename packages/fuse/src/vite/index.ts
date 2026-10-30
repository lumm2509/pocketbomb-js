// pocketbomb-fuse/vite
//
// A Vite plugin that starts fuse with the dev server and exposes its env (POCKETBOMB_URL and the
// seed env, e.g. the API keys) to `process.env` of the dev server process.
import type { Plugin } from "vite";
import { startFuse, type Fuse, type FuseOptions } from "../node/fuse";

export interface FuseVitePluginOptions extends FuseOptions {
  /**
   * Called once the server is running (e.g. to run the codegen).
   */
  onStart?: (fuse: Fuse) => void | Promise<void>;
}

/**
 * Starts fuse once per dev server (not for builds) unless POCKETBOMB_URL is already set
 * (e.g. by `dynamite dev` or an external server).
 */
export function fuse(options: FuseVitePluginOptions = {}): Plugin {
  let running: Fuse | null = null;

  return {
    name: "pocketbomb:fuse",
    apply: "serve",
    async configureServer(server) {
      if (process.env.POCKETBOMB_URL) {
        return;
      }

      running = await startFuse(options);
      Object.assign(process.env, running.env);
      server.config.logger.info("  fuse: PocketBomb running on " + running.url);

      await options.onStart?.(running);
    },
    // called when the dev server closes (also on restarts)
    async buildEnd() {
      if (!running) {
        return;
      }

      const stopping = running;
      running = null;
      for (const key in stopping.env) {
        if (process.env[key] === stopping.env[key]) {
          delete process.env[key];
        }
      }
      await stopping.stop();
    },
  };
}

export type { Fuse, FuseOptions };
