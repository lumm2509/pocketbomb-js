import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, describe, expect, test } from "vitest";
import {
  deployManifest,
  formatEnv,
  loadManifest,
  resolveManifest,
  run,
  scopesToPermissions,
  updateEnvFile,
} from "./index";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOML = `
handle = "my-app"
name = "My app"
version = "1.0.0"
application_url = "https://app.example.com"
install_url = "/install"
uninstall_url = "https://app.example.com/uninstall"

[access]
scopes = ["read_orders", "write_orders", "system:read_logs"]

[[webhooks.subscriptions]]
topics = ["orders.create"]
uri = "/webhooks/orders/create"

[[extensions]]
type = "dashboard.navigation"
handle = "home"
label = "My app"
path = "/app"
`;

function writeManifest(content = TOML): string {
  const file = path.join(tmp, "pocketbomb-" + Math.random().toString(36).slice(2) + ".toml");
  fs.writeFileSync(file, content);
  return file;
}

function io() {
  const out: Array<string> = [];
  const err: Array<string> = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}

describe("manifest", function () {
  test("loadManifest() parses the TOML; resolveManifest() resolves the paths against the app URL", function () {
    const manifest = loadManifest(writeManifest());
    assert.equal(manifest.handle, "my-app");
    assert.deepEqual(manifest.access?.scopes, ["read_orders", "write_orders", "system:read_logs"]);

    const resolved = resolveManifest(manifest);
    assert.equal(resolved.application_url, "https://app.example.com");
    assert.equal(resolved.install_url, "https://app.example.com/install");
    assert.equal(resolved.uninstall_url, "https://app.example.com/uninstall");
    assert.equal(
      resolved.webhooks?.subscriptions?.[0].uri,
      "https://app.example.com/webhooks/orders/create",
    );
    assert.equal(manifest.install_url, "/install", "the input is not mutated");

    const dev = resolveManifest(manifest, "http://localhost:4321/");
    assert.equal(dev.application_url, "http://localhost:4321");
    assert.equal(dev.install_url, "http://localhost:4321/install");
    assert.equal(dev.uninstall_url, "https://app.example.com/uninstall", "absolute URLs are kept");

    assert.throws(() => resolveManifest({ handle: "x" }), /application_url/);
    assert.throws(() => loadManifest(writeManifest('name = "no handle"')), /no handle/);
    assert.throws(() => loadManifest(writeManifest("invalid = = toml")));
  });

  test("scopesToPermissions()", function () {
    const collections = [
      { id: "c1", name: "orders" },
      { id: "c2", name: "products" },
    ];
    assert.deepEqual(
      scopesToPermissions(
        ["read_orders", "write_orders", "read_products", "system:read_logs", "system:write_logs"],
        collections,
      ),
      {
        collections: { c1: ["list", "view", "create", "update", "delete"], c2: ["list", "view"] },
        system: { logs: "write" },
      },
    );
    assert.deepEqual(scopesToPermissions(["system:write_logs", "system:read_logs"], []).system, {
      logs: "write",
    });
    assert.throws(() => scopesToPermissions(["read_missing"], collections), /missing collection/);
    assert.throws(() => scopesToPermissions(["bad scope"], collections), /Invalid scope/);
  });

  test("formatEnv() / updateEnvFile()", function () {
    assert.equal(
      formatEnv({ A: "1", B: "with space", C: "http://x:1/y" }),
      'A=1\nB="with space"\nC=http://x:1/y\n',
    );

    const file = path.join(tmp, ".env");
    fs.writeFileSync(file, "# app env\nKEEP=1\nPOCKETBOMB_URL=old\n");
    updateEnvFile(file, { POCKETBOMB_URL: "http://127.0.0.1:1", NEW: "x" });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "# app env\nKEEP=1\nPOCKETBOMB_URL=http://127.0.0.1:1\nNEW=x\n",
    );

    const fresh = path.join(tmp, "fresh.env");
    updateEnvFile(fresh, { A: "1" });
    assert.equal(fs.readFileSync(fresh, "utf8"), "A=1\n");
  });

  test("deployManifest() posts the JSON manifest with the staff token and reports the API errors", async function () {
    const requests: Array<{ url: string; init: any }> = [];
    const ok = (async (url: any, init: any) => {
      requests.push({ url: String(url), init });
      return Response.json({
        created: true,
        unchanged: false,
        application: { id: "a1" },
        version: { version: "1.0.0" },
      });
    }) as typeof fetch;

    const manifest = resolveManifest(loadManifest(writeManifest()));
    const result = await deployManifest({
      url: "https://pb.example.com/",
      token: "tok",
      manifest,
      fetch: ok,
    });
    assert.isTrue(result.created);
    assert.equal(requests[0].url, "https://pb.example.com/api/applications/manifests");
    assert.equal(requests[0].init.headers.authorization, "Bearer tok");
    assert.equal(requests[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(requests[0].init.body), manifest);

    const failing = (async () =>
      Response.json(
        { message: "Invalid application manifest.", data: { handle: { code: "x" } } },
        { status: 400 },
      )) as typeof fetch;
    await expect(
      deployManifest({ url: "https://pb", token: "Bearer t", manifest, fetch: failing }),
    ).rejects.toThrow(/\(400\): Invalid application manifest\. \{"handle"/);
  });
});

describe("detonator CLI", function () {
  test("help, version, unknown, deploy usage and info", async function () {
    const a = io();
    assert.equal(await run([], a.io), 0);
    assert.include(a.out[0], "detonator <command>");

    const v = io();
    assert.equal(await run(["--version"], v.io), 0);
    assert.match(v.out[0], /^\d+\.\d+\.\d+/);

    const u = io();
    assert.equal(await run(["nope"], u.io), 2);

    const saved = { ...process.env };
    delete process.env.POCKETBOMB_URL;
    delete process.env.POCKETBOMB_TOKEN;
    try {
      const d = io();
      assert.equal(await run(["deploy"], d.io), 2);
      assert.include(d.err[0], "--url and --token are required");

      process.env.POCKETBOMB_CLIENT_SECRET = "never_printed_secret";
      const i = io();
      assert.equal(await run(["info", "--config", writeManifest()], i.io), 0);
      const text = i.out.join("\n");
      assert.include(text, "handle                 my-app 1.0.0");
      assert.include(text, "scopes                 read_orders, write_orders, system:read_logs");
      assert.include(text, "orders.create -> /webhooks/orders/create");
      assert.include(text, "dashboard.navigation:home /app");
      assert.include(text, "POCKETBOMB_CLIENT_SECRET (set)");
      assert.notInclude(text, "never_printed_secret");

      const missing = io();
      assert.equal(await run(["info", "--config", path.join(tmp, "missing.toml")], missing.io), 1);
    } finally {
      process.env = saved;
    }
  });
});
