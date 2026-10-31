// `detonator install` against a real PocketBomb server (fuse).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { signInStaff, startFuse, type Fuse } from "pocketbomb-fuse/node";
import type { DashboardClient } from "pocketbomb-primer/internal";
import { run } from "../src/cli/index";
import { scopesToPermissions } from "../src/server/index";
import { fuseOptions, Receiver } from "./helpers";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-install-"));
const receiver = new Receiver();
let fuse: Fuse;
let owner: DashboardClient;
let notesId = "";

const io = () => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
};

function manifest(handle: string, urls: string): string {
  const file = path.join(tmp, handle + ".toml");
  fs.writeFileSync(
    file,
    `handle = "${handle}"
name = "${handle}"
version = "1.0.0"
${urls}

[access]
scopes = ["read_notes", "write_notes", "system:read_logs"]
`,
  );
  return file;
}

const args = (command: string, config: string, ...extra: Array<string>) => [
  command,
  "--url",
  fuse.url,
  "--token",
  owner.authStore.token,
  "--config",
  config,
  ...extra,
];

const find = async (handle: string) =>
  (await owner.applications.getList()).items.find((a) => a.handle === handle);

beforeAll(async () => {
  fuse = await startFuse(fuseOptions());
  owner = await signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);
  await receiver.start();
  const notes = await owner.collections.create({
    name: "notes",
    type: "base",
    fields: [{ name: "title", type: "text" }],
  });
  notesId = notes.id;
});

afterAll(async () => {
  await receiver.stop();
  await fuse?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detonator install", function () {
  test("requires the server and a deployed application", async function () {
    const saved = { ...process.env };
    delete process.env.POCKETBOMB_URL;
    delete process.env.POCKETBOMB_TOKEN;
    try {
      const a = io();
      assert.equal(await run(["install"], a.io), 2);
      assert.include(a.err[0], "--url and --token are required");
    } finally {
      process.env = saved;
    }

    const b = io();
    assert.equal(await run(args("install", manifest("not-deployed", "")), b.io), 1);
    assert.include(b.err[0], "isn't deployed");
  });

  test("the manifest scopes, delivered to the install_url, idempotent", async function () {
    const config = manifest(
      "notified-app",
      `application_url = "${receiver.url}"\ninstall_url = "/install"\nuninstall_url = "/uninstall"`,
    );
    assert.equal(await run(args("deploy", config), io().io), 0);

    const first = io();
    assert.equal(await run(args("install", config), first.io), 0);
    assert.include(first.out[0], "credentials delivered to the install_url");
    assert.isTrue(receiver.requests.some((r) => r.path === "/install"));

    const installed = (await find("notified-app"))!.installation!;
    assert.deepEqual(installed.permissions.collections![notesId].toSorted(), [
      "create",
      "delete",
      "list",
      "update",
      "view",
    ]);
    assert.equal(installed.permissions.system!.logs, "read");

    const deliveries = receiver.requests.length;
    const second = io();
    assert.equal(await run(args("install", config), second.io), 0);
    assert.include(second.out[0], "already installed (installation " + installed.id + ")");
    assert.equal(receiver.requests.length, deliveries, "no new notification");
    assert.equal(
      (await find("notified-app"))!.installation!.secretRotatedAt,
      installed.secretRotatedAt,
    );
  });

  test("without an install_url the credentials go to the env file, not the output", async function () {
    const config = manifest("env-app", `application_url = "https://env.example.com"`);
    const dotenv = path.join(tmp, "env-app.env");
    assert.equal(await run(args("deploy", config), io().io), 0);

    const a = io();
    assert.equal(await run(args("install", config, "--dotenv", dotenv), a.io), 0);
    assert.include(a.out[0], "credentials in env-app.env");

    const env = fs.readFileSync(dotenv, "utf8");
    const secret = env.match(/^POCKETBOMB_CLIENT_SECRET=(.+)$/m)?.[1];
    assert.isOk(secret);
    assert.match(env, /^POCKETBOMB_WEBHOOK_SECRET=.+$/m);
    assert.notInclude(a.out.join("\n"), secret!);
  });

  test("a scope of a missing collection fails before installing", async function () {
    const file = manifest("bad-app", `application_url = "https://bad.example.com"`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("read_notes", "read_missing"));
    assert.equal(await run(args("deploy", file), io().io), 0);
    await expect(run(args("install", file), io().io)).rejects.toThrow(/missing collection missing/);
    assert.isNull((await find("bad-app"))!.installation);
  });

  test("scopesToPermissions is exported by the server entry", function () {
    const result = scopesToPermissions(["read_notes"], [{ id: "c1", name: "notes" }]);
    assert.deepEqual(result.collections.c1, ["list", "view"]);
  });
});
