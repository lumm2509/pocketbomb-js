import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { buildSchema, introspectionFromSchema } from "graphql";
import { build, createServer, type InlineConfig } from "vite";
import { afterEach, assert, beforeEach, describe, expect, test } from "vitest";
import { dynamite, pocketbombEnv } from "./index";

const tmpRoot = path.join(__dirname, "../../.test-tmp");
const PRIVATE_KEY = "pb_sk_test_private_key_value_123";
const PUBLIC_KEY = "pb_pk_test_public_key_value_456";

let root = "";
const savedEnv = { ...process.env };

function write(rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readDir(dir: string): string {
  let result = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      result += fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8") + "\n";
    }
  }
  return result;
}

function baseConfig(extra: InlineConfig = {}): InlineConfig {
  return { root, configFile: false, logLevel: "silent", ...extra };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(tmpRoot, "vite-"));
  for (const key in process.env) {
    if (key.startsWith("POCKETBOMB_")) delete process.env[key];
  }
  write("index.html", '<!doctype html><script type="module" src="/src/main.ts"></script>');
  write(
    "src/main.ts",
    "export const config = { url: import.meta.env.POCKETBOMB_URL, key: import.meta.env.POCKETBOMB_PUBLIC_KEY };\nconsole.log(config);\n",
  );
  write(
    "src/server.ts",
    "export const privateKey = process.env.POCKETBOMB_PRIVATE_KEY;\nexport const url = process.env.POCKETBOMB_URL;\nexport const pub = import.meta.env.POCKETBOMB_URL + import.meta.env.POCKETBOMB_PUBLIC_KEY;\n",
  );
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

describe("dynamite vite plugin: env and the private key", function () {
  test("the client build gets the public env and never the private key; the SSR build reads process.env", async function () {
    write(
      ".env",
      `POCKETBOMB_URL=https://pb.example.com\nPOCKETBOMB_PUBLIC_KEY=${PUBLIC_KEY}\nPOCKETBOMB_PRIVATE_KEY=${PRIVATE_KEY}\n`,
    );

    await build(baseConfig({ plugins: [dynamite()], build: { outDir: "dist/client" } }));
    const client = readDir(path.join(root, "dist/client"));
    assert.include(client, "https://pb.example.com");
    assert.include(client, PUBLIC_KEY);
    assert.notInclude(client, PRIVATE_KEY);
    assert.notInclude(client, "X-PB-Private-Key");

    await build(
      baseConfig({
        plugins: [dynamite()],
        build: { ssr: "src/server.ts", outDir: "dist/server" },
      }),
    );
    const server = readDir(path.join(root, "dist/server"));
    assert.include(server, "process.env.POCKETBOMB_PRIVATE_KEY");
    assert.notInclude(server, PRIVATE_KEY, "not inlined in the server build either");
    assert.include(
      server,
      "https://pb.example.com",
      "the public env is inlined in the SSR modules too",
    );
    assert.include(server, PUBLIC_KEY);

    // the env files are exposed to the server process
    assert.equal(process.env.POCKETBOMB_PRIVATE_KEY, PRIVATE_KEY);
  });

  test("a client module with the private key value fails the build", async function () {
    process.env.POCKETBOMB_PRIVATE_KEY = PRIVATE_KEY;
    write("src/main.ts", `export const leaked = "${PRIVATE_KEY}";\nconsole.log(leaked);\n`);

    await expect(build(baseConfig({ plugins: [dynamite()] }))).rejects.toThrow(
      /uses the PocketBomb private key in client code/,
    );
  });

  test("a client module reading import.meta.env.POCKETBOMB_PRIVATE_KEY fails the build", async function () {
    write("src/main.ts", "console.log(import.meta.env.POCKETBOMB_PRIVATE_KEY);\n");

    await expect(build(baseConfig({ plugins: [dynamite()] }))).rejects.toThrow(
      /must stay server-only/,
    );
  });

  test("pre-optimizes the entries with the dev proxy on and off", function () {
    const include = ["pocketbomb-dynamite/graphql", "pocketbomb-dynamite/react"];
    for (const proxy of [true, false]) {
      const plugin = dynamite({ proxy, codegen: false }) as any;
      const config = plugin.config({ root }, { command: "serve", mode: "development" });
      assert.deepEqual(config.optimizeDeps.include, include);
    }
  });

  test("an envPrefix exposing the private key is rejected", async function () {
    await expect(
      build(baseConfig({ plugins: [dynamite()], envPrefix: ["VITE_", "POCKETBOMB_"] })),
    ).rejects.toThrow(/envPrefix exposes POCKETBOMB_PRIVATE_KEY/);
  });

  test("pocketbombEnv() merges the env files and process.env", function () {
    write(".env", "POCKETBOMB_URL=from-file\nPOCKETBOMB_PUBLIC_KEY=file-key\nOTHER=x\n");
    process.env.POCKETBOMB_PUBLIC_KEY = "process-key";

    assert.deepEqual(pocketbombEnv("development", root), {
      POCKETBOMB_URL: "from-file",
      POCKETBOMB_PUBLIC_KEY: "process-key",
    });
  });
});

describe("dynamite vite plugin: dev proxy and codegen", function () {
  test("proxies /api, /oauth2 and /.well-known (Host preserved), the client URL is same-origin and the codegen runs with the first request", async function () {
    const schema = buildSchema("type Query { hello: String }");
    const received: Array<{ url: string; host: string }> = [];
    const target = http.createServer((req, res) => {
      received.push({ url: req.url || "", host: req.headers.host || "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/api/graphql" ? { data: introspectionFromSchema(schema) } : { ok: req.url },
        ),
      );
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetURL = "http://127.0.0.1:" + (target.address() as net.AddressInfo).port;

    process.env.POCKETBOMB_URL = targetURL;
    process.env.POCKETBOMB_PUBLIC_KEY = PUBLIC_KEY;

    const server = await createServer(
      baseConfig({
        plugins: [dynamite()],
        server: { port: 0, host: "127.0.0.1" },
      }),
    );
    try {
      await server.listen();
      const devURL = "http://127.0.0.1:" + (server.httpServer!.address() as net.AddressInfo).port;
      assert.isFalse(fs.existsSync(path.join(root, ".dynamite")), "nothing runs before a request");

      for (const p of [
        "/api/health",
        "/oauth2/users/authorize?x=1",
        "/.well-known/openid-configuration",
      ]) {
        const res = await fetch(devURL + p);
        assert.deepEqual(await res.json(), { ok: p });
      }
      const proxied = received.filter((r) => r.url !== "/api/graphql");
      assert.lengthOf(proxied, 3);
      for (const r of proxied) {
        assert.equal(r.host, new URL(devURL).host, "the Host header is preserved");
      }

      const main = await server.transformRequest("/src/main.ts");
      assert.include(main!.code, 'url: "/"');
      const ssr = await server.environments.ssr.transformRequest("/src/server.ts");
      assert.include(ssr!.code, JSON.stringify(targetURL), "the SSR modules get the absolute URL");
      assert.include(main!.code, JSON.stringify(PUBLIC_KEY));

      // the codegen ran with the first dev request
      assert.include(
        fs.readFileSync(path.join(root, ".dynamite/schema.graphql"), "utf8"),
        "hello: String",
      );
      assert.isTrue(fs.existsSync(path.join(root, "pocketbomb-env.d.ts")));
    } finally {
      await server.close();
      await new Promise((r) => target.close(r));
    }
  });

  test("proxy: false keeps the absolute client URL; no codegen without a public key", async function () {
    process.env.POCKETBOMB_URL = "http://127.0.0.1:9";

    const server = await createServer(
      baseConfig({ plugins: [dynamite({ proxy: false })], server: { middlewareMode: true } }),
    );
    try {
      const main = await server.transformRequest("/src/main.ts");
      assert.include(main!.code, 'url: "http://127.0.0.1:9"');
      assert.isUndefined(server.config.server.proxy?.["/api"]);
      assert.isFalse(fs.existsSync(path.join(root, ".dynamite")));
    } finally {
      await server.close();
    }
  });
});
