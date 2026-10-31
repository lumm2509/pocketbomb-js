// pocketbomb-dynamite/vite
//
// The Vite plugin of the PocketBomb apps:
// - env: POCKETBOMB_URL and POCKETBOMB_PUBLIC_KEY are exposed to the client code as
//   `import.meta.env.*`; the private key stays server-only (`process.env`) and the client
//   bundles are checked to never contain it
// - dev proxy of /api, /oauth2 and /.well-known to the PocketBomb server (same-origin dev)
// - the GraphQL codegen on start and on schema changes (dev)
// - fuse: a local PocketBomb server started with the dev server
import type { Connect, Plugin, ResolvedConfig } from "vite";
import { loadEnv } from "vite";
import type { Fuse, FuseOptions } from "pocketbomb-fuse/node";

type ProxyOptions = {
  target: string;
  changeOrigin: boolean;
  ws: boolean;
  configure: (proxy: any) => void;
};
import { codegen, watchCodegen, type GenerateOptions } from "../cli/codegen";

export const PUBLIC_ENV_KEYS = ["POCKETBOMB_URL", "POCKETBOMB_PUBLIC_KEY"] as const;
export const PRIVATE_KEY_ENV = "POCKETBOMB_PRIVATE_KEY";
export const PROXIED_PATHS = ["/api", "/oauth2", "/.well-known"] as const;

const PUBLIC_ENV_PATTERN = /\bimport\.meta\.env\.(POCKETBOMB_URL|POCKETBOMB_PUBLIC_KEY)\b/g;

export interface DynamitePluginOptions {
  /**
   * Start a local PocketBomb server with fuse for the dev server
   * (skipped when POCKETBOMB_URL is set).
   */
  fuse?: boolean | FuseOptions;

  /**
   * Proxy /api, /oauth2 and /.well-known to the PocketBomb server in dev (default to true);
   * the client `POCKETBOMB_URL` is then "/" (same origin).
   */
  proxy?: boolean;

  /**
   * Run the GraphQL codegen on start and on schema changes in dev (default to true when
   * a public key is available).
   */
  codegen?: boolean | (GenerateOptions & { interval?: number });
}

function isSecretExposedByPrefix(prefixes: string | Array<string> | undefined): boolean {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes || "VITE_"];
  return list.some((prefix) => prefix !== "" && PRIVATE_KEY_ENV.startsWith(prefix));
}

/**
 * Returns the PocketBomb variables of the mode env files (`.env*`) and of `process.env`
 * (the latter wins).
 */
export function pocketbombEnv(mode: string, root: string): Record<string, string> {
  const fromFiles = loadEnv(mode, root, "POCKETBOMB_");
  const result: Record<string, string> = { ...fromFiles };
  for (const key in process.env) {
    if (key.startsWith("POCKETBOMB_") && process.env[key]) {
      result[key] = process.env[key]!;
    }
  }
  return result;
}

/**
 * The PocketBomb Vite plugin (see the module docs).
 */
export function dynamite(options: DynamitePluginOptions = {}): Plugin {
  let env: Record<string, string> = {};
  let fuse: Fuse | null = null;
  let isDev = false;
  let stopCodegen = () => {};
  let resolved: ResolvedConfig | null = null;
  let fusePending = false;
  const proxies: Array<{ options: { target?: string } }> = [];

  const proxyEnabled = () =>
    isDev && options.proxy !== false && (!!env.POCKETBOMB_URL || fusePending);

  const startCodegen = async () => {
    const codegenOptions = options.codegen;
    if (codegenOptions === false || !env.POCKETBOMB_URL || !env.POCKETBOMB_PUBLIC_KEY) {
      return;
    }

    const extra = typeof codegenOptions === "object" ? codegenOptions : {};
    const base = {
      url: env.POCKETBOMB_URL,
      publicKey: env.POCKETBOMB_PUBLIC_KEY,
      cwd: resolved?.root,
      ...extra,
    };

    try {
      await codegen(base);
    } catch (err) {
      resolved?.logger.warn("[dynamite] codegen: " + String((err as Error)?.message || err));
    }

    stopCodegen = watchCodegen({
      ...base,
      onChange: (result) => resolved?.logger.info("[dynamite] codegen: " + result.envFile),
      onError: (err) =>
        resolved?.logger.warn("[dynamite] codegen: " + String((err as Error)?.message || err)),
    });
  };

  const plugin: Plugin = {
    name: "pocketbomb:dynamite",

    config(config, configEnv) {
      isDev = configEnv.command === "serve";
      const root = config.root || process.cwd();

      if (isSecretExposedByPrefix(config.envPrefix)) {
        throw new Error(
          "[dynamite] the Vite envPrefix exposes " +
            PRIVATE_KEY_ENV +
            " to the client code; use a narrower prefix.",
        );
      }

      env = pocketbombEnv(configEnv.mode, root);
      // make the env files available to the server code too
      for (const key in env) {
        process.env[key] ??= env[key];
      }

      // fuse is started with the first dev request (not by the build/typegen helper servers)
      fusePending = isDev && !!options.fuse && !env.POCKETBOMB_URL;

      // discovered late they make a first visit reload the page halfway through
      const optimizeDeps = {
        include: ["pocketbomb-dynamite/graphql", "pocketbomb-dynamite/react"],
      };

      if (!proxyEnabled()) {
        return { optimizeDeps };
      }

      const proxy: Record<string, ProxyOptions> = {};
      for (const path of PROXIED_PATHS) {
        proxy[path] = {
          // the target of a pending fuse is set once it runs
          target: env.POCKETBOMB_URL || "http://127.0.0.1:9",
          // the Host header is preserved so that the same-origin redirect URIs are accepted
          changeOrigin: false,
          ws: true,
          configure: (server: { options: { target?: string } }) => proxies.push(server),
        };
      }

      return { optimizeDeps, server: { proxy } };
    },

    configResolved(config) {
      resolved = config;
    },

    configureServer(server) {
      let ready: Promise<void> | null = null;

      const start = async () => {
        if (fusePending) {
          fusePending = false;
          const { startFuse } = await import("pocketbomb-fuse/node");
          fuse = await startFuse(options.fuse === true ? {} : (options.fuse as FuseOptions));
          Object.assign(process.env, fuse.env);
          env = { ...env, ...fuse.env };
          server.config.logger.info("[dynamite] fuse: PocketBomb running on " + fuse.url);
        }

        for (const proxy of proxies) {
          proxy.options.target = env.POCKETBOMB_URL;
        }

        await startCodegen();
      };

      // the dev runtime (fuse, codegen) starts with the first request
      const ensureStarted: Connect.NextHandleFunction = (_req, _res, next) => {
        ready ??= start();
        ready.then(() => next(), next);
      };
      server.middlewares.use(ensureStarted);
    },

    // note: the public env is inlined by this transform (in dev Vite shares the `define` of
    // `import.meta.env.*` between the client and the SSR modules): the client gets the browser
    // URL ("/" with the dev proxy) and the SSR modules the absolute URL
    transform(code, id) {
      if (id.includes("/node_modules/")) {
        return;
      }

      const isClient = this.environment?.name === "client";
      const privateKey = env[PRIVATE_KEY_ENV];
      if (
        isClient &&
        ((privateKey && code.includes(privateKey)) ||
          code.includes("import.meta.env." + PRIVATE_KEY_ENV))
      ) {
        this.error(
          "[dynamite] " +
            id +
            " uses the PocketBomb private key in client code; it must stay server-only.",
        );
      }

      if (!code.includes("import.meta.env.POCKETBOMB_")) {
        return;
      }

      const values: Record<string, string> = {
        POCKETBOMB_URL: isClient && proxyEnabled() ? "/" : env.POCKETBOMB_URL || "",
        POCKETBOMB_PUBLIC_KEY: env.POCKETBOMB_PUBLIC_KEY || "",
      };

      return {
        code: code.replace(PUBLIC_ENV_PATTERN, (_, key: string) => JSON.stringify(values[key])),
        map: null,
      };
    },

    generateBundle(_, bundle) {
      if (this.environment?.name !== "client") {
        return;
      }

      const privateKey = env[PRIVATE_KEY_ENV];
      if (!privateKey) {
        return;
      }

      for (const file in bundle) {
        const item = bundle[file];
        const content =
          item.type === "chunk"
            ? item.code
            : typeof item.source === "string"
              ? item.source
              : new TextDecoder().decode(item.source);
        if (content.includes(privateKey)) {
          this.error(
            "[dynamite] the client asset " + file + " contains the PocketBomb private key.",
          );
        }
      }
    },

    async buildEnd() {
      stopCodegen();
      stopCodegen = () => {};

      if (fuse) {
        const stopping = fuse;
        fuse = null;
        for (const key in stopping.env) {
          if (process.env[key] === stopping.env[key]) {
            delete process.env[key];
          }
        }
        await stopping.stop();
      }
    },
  };

  return plugin;
}
