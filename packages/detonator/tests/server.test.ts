// The detonator server toolkit against a real PocketBomb server (fuse): install notification,
// extension launch (online session), managed webhook, offline admin, rotation and uninstall.
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { signInStaff, startFuse, type Fuse } from "@pocketbomb/fuse/node";
import type { DashboardClient } from "@pocketbomb/primer/internal";
import { createRequestListener } from "../src/adapters/node/index";
import { detonator, type WebhookContext } from "../src/server/index";
import { SqliteSessionStorage } from "../src/session-storage/index";
import { fuseOptions } from "./helpers";

const HANDLE = "it-detonator";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-it-"));

let fuse: Fuse;
let owner: DashboardClient;
let appServer: http.Server;
let appUrl = "";
let storage: SqliteSessionStorage;
let app: ReturnType<typeof detonator>;
let ordersId = "";
let installationId = "";
let issuer = "";

const events: Array<string> = [];
const webhooks: Array<WebhookContext> = [];
let webhookWaiters: Array<(w: WebhookContext) => void> = [];
let eventWaiters: Array<{ event: string; resolve: () => void }> = [];

const nextWebhook = () => new Promise<WebhookContext>((r) => webhookWaiters.push(r));
const nextEvent = (event: string) =>
  new Promise<void>((resolve) => eventWaiters.push({ event, resolve }));

beforeAll(async () => {
  fuse = await startFuse(fuseOptions());
  issuer = fuse.url + "/oauth2/_applicationInstallations";
  owner = await signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);
  await owner.settings.update({
    meta: { appURL: fuse.url },
    webhooks: { allowPrivateTargets: true },
  });

  ordersId = (
    await owner.collections.create({
      name: "orders",
      type: "base",
      fields: [{ name: "title", type: "text" }],
      listRule: "",
      viewRule: "",
      createRule: "",
    })
  ).id;

  appServer = http.createServer();
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appUrl = "http://127.0.0.1:" + (appServer.address() as net.AddressInfo).port;

  storage = new SqliteSessionStorage(path.join(tmp, "sessions.sqlite"));
  app = detonator({ appUrl, handle: HANDLE, sessionStorage: storage });

  appServer.on(
    "request",
    createRequestListener(async (request) => {
      const { pathname } = new URL(request.url);
      try {
        if (pathname === "/install" || pathname === "/uninstall") {
          const result = await app.authenticate.install(request);
          events.push(result.event);
          for (const waiter of eventWaiters.filter((w) => w.event === result.event))
            waiter.resolve();
          eventWaiters = eventWaiters.filter((w) => w.event !== result.event);
          return result.response;
        }
        if (pathname === "/webhooks/orders/create") {
          const hook = await app.authenticate.webhook(request);
          webhooks.push(hook);
          for (const w of webhookWaiters) w(hook);
          webhookWaiters = [];
          return new Response("ok");
        }
        if (pathname.startsWith("/proxy")) {
          const { installation, customerId, pathPrefix } =
            await app.authenticate.public.appProxy(request);
          return Response.json({ installation: installation.id, customerId, pathPrefix });
        }
        if (pathname === "/app" && request.method === "POST") {
          return (await app.authenticate.launch(request)).redirect();
        }
        if (pathname === "/app") {
          const { admin, staff, record, extension } = await app.authenticate.admin(request);
          const me = await admin.send("/api/permissions/me", { requestKey: null });
          const orders = await admin.collection("orders").getList(1, 1);
          return Response.json({ me, staff, record, extension, orders: orders.totalItems });
        }
        return new Response("not found", { status: 404 });
      } catch (err) {
        if (err instanceof Response) return err;
        throw err;
      }
    }),
  );
});

afterAll(async () => {
  await new Promise((r) => appServer?.close(r));
  storage?.close();
  await fuse?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detonator server toolkit (real server)", function () {
  test("install: the signed notification is verified and the installation stored (sqlite)", async function () {
    const manifest = {
      handle: HANDLE,
      name: "Detonator integration",
      version: "1.0.0",
      application_url: appUrl,
      install_url: appUrl + "/install",
      uninstall_url: appUrl + "/uninstall",
      access: { scopes: ["read_orders", "write_orders", "write_app_proxy"] },
      app_proxy: { url: appUrl + "/proxy", prefix: "apps", subpath: "it-proxy" },
      webhooks: {
        subscriptions: [{ topics: ["orders.create"], uri: appUrl + "/webhooks/orders/create" }],
      },
      extensions: [{ type: "dashboard.navigation", handle: "home", label: "Home", path: "/app" }],
    };
    const imported = await owner.applications.importManifest(manifest as any, "json");

    const installed = nextEvent("application.installed");
    const result = await owner.applications.install(imported.application.id, {
      collections: { [ordersId]: ["list", "view", "create"] },
      system: { app_proxy: "write" },
    });
    await installed;
    installationId = result.installation.id;

    assert.isTrue(result.notified);
    const stored = await storage.loadInstallation(issuer, installationId);
    assert.equal(stored?.clientId, result.clientId);
    assert.isNotEmpty(stored?.clientSecret);
    assert.isNotEmpty(stored?.webhookSecret);
    assert.equal(stored?.url, fuse.url);
    assert.sameMembers(stored!.scopes, ["read_orders", "system:write_app_proxy", "write_orders"]);
    assert.equal(stored?.proxyPathPrefix, "/apps/it-proxy");
  });

  test("launch + session token: no cookies -> admin (staff ∩ grant), bounce without a token", async function () {
    const launch = await owner.applications.launch(installationId, "home");
    assert.equal(launch.url, appUrl + "/app");

    const post = await fetch(launch.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: fuse.url },
      body: new URLSearchParams({ launch_token: launch.launchToken }).toString(),
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.get("location"), "/app?issuer=" + encodeURIComponent(issuer));
    assert.isEmpty(post.headers.getSetCookie());

    // no token -> bounce
    const bounce = await fetch(appUrl + post.headers.get("location"), {
      headers: { "sec-fetch-dest": "iframe" },
    });
    assert.equal(bounce.status, 200);
    assert.include(await bounce.text(), "detonator-bounce");

    const { sessionToken } = await owner.send(
      "/api/applications/installations/" + installationId + "/session-token",
      { method: "POST", body: { extension: "home" } },
    );

    const page = await fetch(appUrl + "/app", {
      headers: { authorization: "Bearer " + sessionToken },
    });
    assert.equal(page.status, 200);
    const data = await page.json();
    assert.equal(data.me.kind, "staff");
    assert.equal(data.me.onBehalfOf?.installationId, installationId);
    assert.isFalse(data.me.owner, "the Owner bypass is not applied");
    assert.equal(data.staff.id, owner.authStore.record?.id);
    assert.equal(data.extension, "home");

    // the session token is never an auth token
    const asBearer = await fetch(fuse.url + "/api/permissions/me", {
      headers: { authorization: "Bearer " + sessionToken },
    });
    assert.notEqual(asBearer.status, 200);

    // replayed launch token -> relaunch page
    const replay = await fetch(launch.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ launch_token: launch.launchToken }).toString(),
    });
    assert.equal(replay.status, 401);
  });

  test("managed webhook: offline admin create -> verified delivery with the installation", async function () {
    const { admin } = await app.unauthenticated.admin(issuer);
    const delivered = nextWebhook();
    const order = await admin.collection("orders").create({ title: "webhook order" });

    const hook = await delivered;
    assert.equal(hook.topic, "orders.create");
    assert.equal(hook.installation.id, installationId);
    assert.equal(hook.payload.action, "create");
    assert.equal(hook.payload.collectionName, "orders");
    assert.equal(hook.payload.record.id, order.id);
    assert.isNotEmpty(hook.eventId);
  });

  test("app proxy: the forwarded request is verified, the customized path is notified", async function () {
    const before = await fetch(fuse.url + "/apps/it-proxy/x?a=1&empty=", {
      method: "POST",
      body: "payload",
    });
    assert.equal(before.status, 200, await before.clone().text());
    assert.deepEqual(await before.json(), {
      installation: installationId,
      customerId: "",
      pathPrefix: "/apps/it-proxy",
    });

    const updated = nextEvent("application.app_proxy_updated");
    await owner.send("/api/applications/installations/" + installationId, {
      method: "PATCH",
      body: { proxyPrefix: "tools", proxySubpath: "it-custom" },
    });
    await updated;
    events.pop();

    assert.equal(
      (await storage.loadInstallation(issuer, installationId))?.proxyPathPrefix,
      "/tools/it-custom",
    );
    assert.equal((await fetch(fuse.url + "/apps/it-proxy/x")).status, 404);
    assert.equal((await fetch(fuse.url + "/tools/it-custom/x")).status, 200);

    // a directly forged request of the same app route
    assert.equal(
      (
        await fetch(
          appUrl +
            "/proxy/x?issuer=" +
            encodeURIComponent(issuer) +
            "&path_prefix=/tools/it-custom&signature=x",
        )
      ).status,
      401,
    );
  });

  test("rotate: credentials_rotated updates the secrets; uninstall: deleted and the admin calls 401", async function () {
    const before = await storage.loadInstallation(issuer, installationId);

    const rotated = nextEvent("application.credentials_rotated");
    await owner.applications.rotateSecret(installationId);
    await rotated;

    const after = await storage.loadInstallation(issuer, installationId);
    assert.notEqual(after?.clientSecret, before?.clientSecret);
    assert.notEqual(after?.webhookSecret, before?.webhookSecret);

    // the new credentials work (a new offline client of the new secret)
    const { admin } = await app.unauthenticated.admin(issuer);
    await admin.collection("orders").getList(1, 1);

    const uninstalled = nextEvent("application.uninstalled");
    await owner.applications.uninstall(installationId);
    await uninstalled;

    assert.isUndefined(await storage.loadInstallation(issuer, installationId));
    await expect(app.unauthenticated.admin(issuer)).rejects.toThrow(/No installation/);
    await expect(admin.collection("orders").getList(1, 1)).rejects.toMatchObject({ status: 401 });
    assert.deepEqual(events, [
      "application.installed",
      "application.credentials_rotated",
      "application.uninstalled",
    ]);
  });
});
