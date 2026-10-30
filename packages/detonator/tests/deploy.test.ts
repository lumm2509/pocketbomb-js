// `detonator deploy` against a real PocketBomb server (fuse).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { signInStaff, startFuse, type Fuse } from "@pocketbomb/fuse/node";
import type { DashboardClient } from "@pocketbomb/primer/internal";
import { run } from "../src/cli/index";
import { fuseOptions } from "./helpers";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-deploy-"));
let fuse: Fuse;
let owner: DashboardClient;

beforeAll(async () => {
  fuse = await startFuse(fuseOptions());
  owner = await signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);
});

afterAll(async () => {
  await fuse?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifest(version: string): string {
  const file = path.join(tmp, "pocketbomb.app." + version + ".toml");
  fs.writeFileSync(
    file,
    `handle = "deployed-app"
name = "Deployed app"
version = "${version}"
application_url = "https://deployed.example.com"
install_url = "/install"
uninstall_url = "/uninstall"

[access]
scopes = ["read_orders"]

[[webhooks.subscriptions]]
topics = ["orders.create"]
uri = "/webhooks/orders/create"

[[extensions]]
type = "dashboard.navigation"
handle = "home"
label = "Deployed"
path = "/app"
`,
  );
  return file;
}

function io() {
  const out: Array<string> = [];
  const err: Array<string> = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}

describe("detonator deploy (real server)", function () {
  test("creates the application, reports an unchanged redeploy and a new version", async function () {
    const token = owner.authStore.token;

    const first = io();
    assert.equal(
      await run(
        ["deploy", "--url", fuse.url, "--token", token, "--config", manifest("1.0.0")],
        first.io,
      ),
      0,
    );
    assert.match(first.out[0], /^created deployed-app 1\.0\.0 \(application \w+\)$/);

    const apps = await owner.applications.getList();
    const deployed = (apps as any).items.find((a: any) => a.handle === "deployed-app");
    assert.isDefined(deployed);

    const again = io();
    await run(
      ["deploy", "--url", fuse.url, "--token", token, "--config", manifest("1.0.0")],
      again.io,
    );
    assert.match(again.out[0], /^unchanged deployed-app 1\.0\.0/);

    const next = io();
    await run(
      ["deploy", "--url", fuse.url, "--token", token, "--config", manifest("1.1.0")],
      next.io,
    );
    assert.match(next.out[0], /^new version of deployed-app 1\.1\.0/);

    // the app URL override (resolved paths)
    const override = io();
    await run(
      [
        "deploy",
        "--url",
        fuse.url,
        "--token",
        token,
        "--config",
        manifest("1.2.0"),
        "--app-url",
        "https://other.example.com",
      ],
      override.io,
    );
    assert.match(override.out[0], /deployed-app 1\.2\.0/);
  });

  test("an invalid token is rejected by the server", async function () {
    await expect(
      run(
        ["deploy", "--url", fuse.url, "--token", "invalid", "--config", manifest("2.0.0")],
        io().io,
      ),
    ).rejects.toThrow(/The manifest deploy failed \(401\)/);
  });
});
