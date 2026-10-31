// `detonator dev` with an existing server and with its own fuse options.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { freePort, signInStaff, startFuse, type Fuse } from "pocketbomb-fuse/node";
import type { DashboardClient } from "pocketbomb-primer/internal";
import { dev, type DevState } from "../src/cli/index";
import { fuseOptions } from "./helpers";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-dev-"));
const silent = { log: () => {}, error: () => {} };
let fuse: Fuse;
let owner: DashboardClient;

beforeAll(async () => {
  fuse = await startFuse(fuseOptions());
  owner = await signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);

  // the smallest app: every signed notification is accepted
  fs.writeFileSync(
    path.join(tmp, "server.mjs"),
    `import http from "node:http";
http.createServer((req, res) => { req.resume(); res.end("ok"); }).listen(process.env.PORT, "localhost");
`,
  );
  fs.writeFileSync(
    path.join(tmp, "pocketbomb.app.toml"),
    `handle = "dev-app"
name = "Dev app"
version = "1.0.0"
install_url = "/install"
uninstall_url = "/uninstall"
`,
  );
});

afterAll(async () => {
  await fuse?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const options = (extra: object) => ({
  cwd: tmp,
  entry: "server.mjs",
  envFile: "test.env",
  io: silent,
  ...extra,
});

describe("detonator dev", function () {
  test("an existing server needs a token", async function () {
    await expect(dev(options({ url: fuse.url }))).rejects.toThrow(/--token .* is required/);
  });

  test("an existing server: used, reused and left running", async function () {
    const server = { url: fuse.url + "/", token: owner.authStore.token };

    const first: DevState = await dev(options(server));
    assert.equal(first.pocketbombUrl, fuse.url);
    assert.isNull(first.owner);
    assert.isTrue(first.notified);
    const env = fs.readFileSync(path.join(tmp, "test.env"), "utf8");
    assert.include(env, "POCKETBOMB_URL=" + fuse.url);
    assert.include(env, "POCKETBOMB_INSTALLATION_ID=" + first.installationId);
    await first.stop();

    // the server keeps running and the next dev reuses the installation with new credentials
    assert.isTrue((await fetch(fuse.url + "/api/health")).ok);
    const second = await dev(options(server));
    assert.equal(second.installationId, first.installationId);
    await second.stop();

    const apps = await owner.applications.getList();
    assert.equal(apps.items.filter((a) => a.handle === "dev-app").length, 1);
  });

  test("the fuse port and data dir", async function () {
    const dataDir = path.join(tmp, "own/pb_data");
    const fusePort = await freePort();

    const state = await dev(options({ dataDir, fusePort, url: "" }));
    try {
      assert.equal(state.pocketbombUrl, "http://127.0.0.1:" + fusePort);
      assert.equal(state.owner?.email, fuse.owner.email);
      assert.isTrue(fs.existsSync(path.join(dataDir, "data.db")));
    } finally {
      await state.stop();
    }
    await expect(fetch(state.pocketbombUrl + "/api/health")).rejects.toThrow();
    // a persistent data dir survives the stop
    assert.isTrue(fs.existsSync(path.join(dataDir, "data.db")));
  });
});
