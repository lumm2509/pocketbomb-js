// Ported from the P1-dropped applications integration spec of the enriched JS SDK.
import { describe, assert, expect, test, beforeAll, afterAll } from "vitest";
import { Client } from "pocketbomb-primer";
import type { DashboardClient } from "pocketbomb-primer/internal";
import { signInStaff, startFuse, type Fuse } from "pocketbomb-fuse/node";
import {
  ApplicationLaunchTokenType,
  createAdminClient,
  exchangeLaunchToken,
  verifyApplicationJWT,
  verifyWebhookSignature,
} from "../src/index";
import { fuseOptions, Receiver } from "./helpers";

let fuse: Fuse;
let url = "";
let issuer = "";

beforeAll(async function () {
  fuse = await startFuse(fuseOptions());
  url = fuse.url;
  issuer = url + "/oauth2/_applicationInstallations";
});

afterAll(async function () {
  await fuse?.stop();
});

/** permissions/me of a client (the roles service is a dashboard internal). */
const me = (client: Client) => client.send("/api/permissions/me", { requestKey: null });
const HANDLE = "int-vendor";

describe("applications (real server)", function () {
  const receiver = new Receiver();
  const notifications: Array<{ path: string; claims: any }> = [];

  let owner: DashboardClient;
  let ordersId = "";
  let installationId = "";
  let credentials: { clientId: string; clientSecret: string; webhookSecret: string } = {
    clientId: "",
    clientSecret: "",
    webhookSecret: "",
  };

  beforeAll(async function () {
    await receiver.start();

    // the application backend: verifies the signed install/uninstall notifications
    receiver.handler = async (req) => {
      if (req.method === "POST" && (req.path === "/install" || req.path === "/uninstall")) {
        const claims = await verifyApplicationJWT({
          token: req.body,
          issuer,
          audience: HANDLE,
        });
        notifications.push({ path: req.path, claims });
        return { status: 200, body: "ok" };
      }

      return { status: 200, body: "ok" };
    };

    owner = await signInStaff(url, fuse.owner.email, fuse.owner.password);
    // the local receiver is a loopback target (like the e2e mock vendor)
    await owner.settings.update({
      meta: { appURL: url },
      webhooks: { allowPrivateTargets: true },
    });

    const orders = await owner.collections.create({
      name: "orders",
      type: "base",
      fields: [{ name: "title", type: "text" }],
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
    });
    ordersId = orders.id;

    await owner.collections.create({
      name: "int_secrets",
      type: "base",
      fields: [{ name: "title", type: "text" }],
    });
  });

  afterAll(async function () {
    await receiver.stop();
  });

  test("import the TOML manifest and install the application", async function () {
    const manifest = `
handle = "${HANDLE}"
name = "Integration vendor"
version = "1.0.0"
description = "The SDK integration suite application"
application_url = "${receiver.url}"
install_url = "${receiver.url}/install"
uninstall_url = "${receiver.url}/uninstall"

[developer]
name = "SDK tests"

[access]
scopes = ["read_orders", "write_orders"]

[[webhooks.subscriptions]]
topics = ["orders.create"]
uri = "${receiver.url}/webhooks"

[[extensions]]
type = "dashboard.navigation"
handle = "home"
label = "Vendor home"
path = "/ext/home"
`;

    const imported = await owner.applications.importManifest(manifest);
    assert.isTrue(imported.created);
    assert.equal(imported.version.sourceFormat, "toml");

    const installed = await owner.applications.install(imported.application.id, {
      collections: { [ordersId]: ["list", "view", "create"] },
    });

    // the secrets were delivered to the install_url (not returned)
    assert.isTrue(installed.notified);
    assert.equal(installed.clientSecret, "");
    installationId = installed.installation.id;

    const notification = notifications.find((n) => n.path === "/install");
    assert.isDefined(notification, "the verified install notification");

    const claims = notification!.claims;
    assert.equal(claims.event, "application.installed");
    assert.equal(claims.installation_id, installationId);
    assert.equal(claims.client_id, installed.clientId);
    assert.equal(claims.token_endpoint, issuer + "/token");
    assert.sameMembers(claims.scopes, ["read_orders", "write_orders"]);

    credentials = {
      clientId: claims.client_id,
      clientSecret: claims.client_secret,
      webhookSecret: claims.webhook_secret,
    };
    assert.isNotEmpty(credentials.clientSecret);
    assert.isNotEmpty(credentials.webhookSecret);

    // a forged notification (other audience) is rejected by the verifier
    await expect(
      verifyApplicationJWT({
        token: receiver.requests[0].body,
        issuer,
        audience: "other",
      }),
    ).rejects.toThrow(/audience/);
  });

  test("admin client: client_credentials CRUD allowed/denied per grant", async function () {
    const admin = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });

    const adminMe = await me(admin);
    assert.equal(adminMe.kind, "application");
    assert.equal(adminMe.application?.handle, HANDLE);

    const created = await admin.collection("orders").create({ title: "order 1" });
    assert.equal(created.title, "order 1");

    const list = await admin.collection("orders").getList();
    assert.isAtLeast(list.totalItems, 1);

    await expect(
      admin.collection("orders").update(created.id, { title: "changed" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(admin.collection("orders").delete(created.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(admin.collection("int_secrets").getList()).rejects.toMatchObject({
      status: 403,
    });

    // narrowed token scopes
    const readOnly = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      scopes: ["read_orders"],
    });
    await readOnly.collection("orders").getList();
    assert.equal(readOnly.authStore.scope, "read_orders");
    await expect(readOnly.collection("orders").create({ title: "x" })).rejects.toMatchObject({
      status: 403,
    });

    // invalid credentials
    const invalid = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: "wrong",
    });
    await expect(invalid.collection("orders").getList()).rejects.toMatchObject({
      status: 401,
      oauth2Error: "invalid_client",
    });
  });

  test("managed webhook delivery verified with the webhook secret", async function () {
    const admin = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });

    const order = await admin.collection("orders").create({ title: "webhook order" });

    const delivery = await receiver.waitFor(
      (r) => r.path === "/webhooks" && r.body.includes(order.id),
    );

    assert.equal(delivery.headers["x-pb-topic"], "orders.create");
    assert.isTrue(
      await verifyWebhookSignature({
        secret: credentials.webhookSecret,
        body: delivery.body,
        headers: delivery.headers as any,
      }),
    );

    // tampered body or wrong secret
    assert.isFalse(
      await verifyWebhookSignature({
        secret: credentials.webhookSecret,
        body: delivery.body.replace("webhook order", "evil order"),
        headers: delivery.headers as any,
      }),
    );
    assert.isFalse(
      await verifyWebhookSignature({
        secret: "other",
        body: delivery.body,
        headers: delivery.headers as any,
      }),
    );
  });

  test("extension launch token exchange (online token = staff ∩ grant)", async function () {
    const extensions = await owner.applications.extensions();
    assert.isTrue(extensions.some((e) => e.handle === "home"));

    const launch = await owner.applications.launch(installationId, "home");
    assert.equal(launch.url, receiver.url + "/ext/home");

    // the vendor verifies the launch token with the issuer JWKS
    const claims = await verifyApplicationJWT({
      token: launch.launchToken,
      issuer,
      audience: credentials.clientId,
      type: ApplicationLaunchTokenType,
    });
    assert.equal(claims.installation_id, installationId);
    assert.equal(claims.extension, "home");
    assert.equal(claims.sub, owner.authStore.record?.id);

    // never accepted as a bearer token
    const asBearer = new Client(url);
    asBearer.authStore.save(launch.launchToken);
    await expect(me(asBearer)).rejects.toMatchObject({ status: 401 });

    const online = await exchangeLaunchToken({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      launchToken: launch.launchToken,
    });

    assert.equal(online.authStore.meta.associatedUser?.id, owner.authStore.record?.id);

    const onlineMe = await me(online);
    assert.equal(onlineMe.kind, "staff");
    assert.equal(onlineMe.onBehalfOf?.installationId, installationId);
    assert.isFalse(onlineMe.owner, "the Owner bypass is not applied");

    await online.collection("orders").getList();
    await expect(online.collection("int_secrets").getList()).rejects.toMatchObject({
      status: 403,
    });

    // single use
    await expect(
      exchangeLaunchToken({
        url,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        launchToken: launch.launchToken,
      }),
    ).rejects.toMatchObject({ oauth2Error: "invalid_grant" });
  });

  test("uninstall: verified notification and rejected credentials", async function () {
    const admin = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    await admin.collection("orders").getList();
    const oldToken = admin.authStore.token;

    assert.isTrue(await owner.applications.uninstall(installationId));

    const notification = await receiver.waitFor((r) => r.path === "/uninstall");
    const claims = await verifyApplicationJWT({
      token: notification.body,
      issuer,
      audience: HANDLE,
    });
    assert.equal(claims.event, "application.uninstalled");

    // the old token and the credentials are rejected
    const stale = new Client(url);
    stale.authStore.save(oldToken);
    await expect(stale.collection("orders").getList()).rejects.toMatchObject({
      status: 401,
    });

    const again = createAdminClient({
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    await expect(again.collection("orders").getList()).rejects.toMatchObject({
      status: 401,
    });
  });
});
