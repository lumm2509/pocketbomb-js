import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { afterAll, assert, describe, expect, test } from "vitest";
import { followHostedFlow, FUSE_OWNER, startFuse, type FuseOptions } from "../src/node/index";
import { fuse as fusePlugin } from "../src/vite/index";

const src = process.env.POCKETBOMB_BIN
  ? {}
  : { src: process.env.POCKETBOMB_SRC || path.resolve(__dirname, "../../../../pocketbase") };
const options = <T extends FuseOptions>(extra: T = {} as T): T => ({
  ...src,
  ...extra,
  log: () => {},
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fuse-it-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("startFuse() (real server)", function () {
  test("starts a healthy server with the Owner, runs the seed once per data dir and stops", async function () {
    const dataDir = path.join(tmp, "dev", "pb_data");
    let seedCalls = 0;

    const seed = async (ctx: any) => {
      seedCalls++;
      assert.deepEqual(ctx.owner, FUSE_OWNER);
      const owner = await ctx.signInOwner();
      const me = await owner.roles.me();
      assert.isTrue(me.owner);
      await owner.collections.create({ name: "fuse_items", type: "base", listRule: "" });
      return { FUSE_SEEDED: "yes", FUSE_URL_SEEN: ctx.url };
    };

    const first = await startFuse(options({ dataDir, seed }));
    try {
      assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(first.dataDir, dataDir);
      assert.equal(first.env.POCKETBOMB_URL, first.url);
      assert.equal(first.env.FUSE_SEEDED, "yes");
      assert.equal(first.env.FUSE_URL_SEEN, first.url);
      assert.equal((await fetch(first.url + "/api/health")).status, 200);
      assert.include(first.logs(), "Server started");
      assert.equal(seedCalls, 1);
    } finally {
      await first.stop();
    }
    await first.stop(); // idempotent
    await expect(fetch(first.url + "/api/health")).rejects.toThrow();

    // the same data dir: no new seed, the seed env is restored and the data is kept
    const second = await startFuse(options({ dataDir, seed }));
    try {
      assert.equal(seedCalls, 1);
      assert.equal(second.env.FUSE_SEEDED, "yes");
      const owner = await second.owner;
      assert.deepEqual(owner, FUSE_OWNER);
      const collections = await fetch(second.url + "/api/collections/fuse_items/records");
      assert.notEqual(collections.status, 404, "the seeded collection survived the restart");
    } finally {
      await second.stop();
    }
    assert.isTrue(fs.existsSync(dataDir), "a provided data dir is kept");
  });

  test("a temporary data dir is removed on stop; the seed module path is supported", async function () {
    const seedFile = path.join(tmp, "seed.mjs");
    fs.writeFileSync(seedFile, "export default async ({ url }) => ({ FROM_MODULE: url });\n");

    const fuse = await startFuse(options({ seed: seedFile }));
    assert.equal(fuse.env.FROM_MODULE, fuse.url);
    assert.isTrue(fs.existsSync(fuse.dataDir));
    await fuse.stop();
    assert.isFalse(fs.existsSync(fuse.dataDir));

    const bad = path.join(tmp, "bad-seed.mjs");
    fs.writeFileSync(bad, "export const x = 1;\n");
    await expect(startFuse(options({ seed: bad }))).rejects.toThrow(/no default export function/);
  });

  test("the hosted login driver signs in the Owner", async function () {
    const fuse = await startFuse(options());
    try {
      const authorize =
        fuse.url +
        "/oauth2/_superusers/authorize?" +
        new URLSearchParams({
          client_id: "pb_dashboard",
          redirect_uri: fuse.url + "/_/",
          response_type: "code",
          scope: "openid",
          state: "s",
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
        });
      const callback = await followHostedFlow(authorize, fuse.url + "/_/", {
        identity: FUSE_OWNER.email,
        password: FUSE_OWNER.password,
      });
      assert.equal(new URL(callback).searchParams.get("state"), "s");
      assert.isNotEmpty(new URL(callback).searchParams.get("code"));
    } finally {
      await fuse.stop();
    }
  });
});

describe("fuse vite plugin (real server)", function () {
  test("starts fuse with the dev server, exposes the env and stops on close", async function () {
    delete process.env.POCKETBOMB_URL;
    let started = "";

    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [
        fusePlugin(
          options({
            seed: async () => ({ POCKETBOMB_PUBLIC_KEY: "pb_pk_test" }),
            onStart: (f: { url: string }) => {
              started = f.url;
            },
          }),
        ),
      ],
    });

    const url = process.env.POCKETBOMB_URL!;
    assert.equal(url, started);
    assert.equal(process.env.POCKETBOMB_PUBLIC_KEY, "pb_pk_test");
    assert.equal((await fetch(url + "/api/health")).status, 200);

    await server.close();
    assert.isUndefined(process.env.POCKETBOMB_URL);
    assert.isUndefined(process.env.POCKETBOMB_PUBLIC_KEY);
    await expect(fetch(url + "/api/health")).rejects.toThrow();
  });

  test("doesn't start fuse when POCKETBOMB_URL is already set", async function () {
    process.env.POCKETBOMB_URL = "http://127.0.0.1:1";
    try {
      const server = await createServer({
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true },
        plugins: [fusePlugin({ bin: "/nonexistent" })],
      });
      await server.close();
      assert.equal(process.env.POCKETBOMB_URL, "http://127.0.0.1:1");
    } finally {
      delete process.env.POCKETBOMB_URL;
    }
  });
});
