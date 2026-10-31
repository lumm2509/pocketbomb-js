import { afterEach, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { sha256Hex, signAppProxyQuery } from "../app-proxy";
import { clearJWKSCache } from "../jwt";
import { MemorySessionStorage } from "../session-storage/memory";
import type { Installation } from "../session-storage/types";
import { generateKey, signJWT, type TestKey } from "../test-utils/keys";
import { dummyJWT } from "../test-utils/mocks";
import { signWebhookBody } from "../webhooks";
import { decodeJWT, detonator, redactIdToken, relaunchResponse, withoutIdToken } from "./detonator";

const PB = "https://pb.example.com";
const ISSUER = PB + "/oauth2/_applicationInstallations";
const HANDLE = "my-app";
const APP = "https://app.example.com";

let key: TestKey;
let otherKey: TestKey;

beforeAll(async () => {
  key = await generateKey("ES256", "k1");
  otherKey = await generateKey("ES256", "k1"); // same kid, another key (forgery)
});

afterEach(() => clearJWKSCache());

type Recorded = { url: string; init: any };

/** A fake PocketBomb instance: the issuer JWKS and the token endpoint. */
function fakeServer(options: { issuer?: string; online?: Record<string, any> } = {}) {
  const issuer = options.issuer || ISSUER;
  const requests: Array<Recorded> = [];
  const offlineTokens: Array<string> = [];
  let tokens = 0;
  let exchangeFails = false;
  let onlineEnded = false;

  const fetchFunc = (async (input: RequestInfo | URL, init: any = {}) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === issuer + "/jwks.json") {
      return Response.json({ keys: [key.jwk] });
    }

    if (url === issuer + "/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "client_credentials") {
        tokens++;
        // a JWT (the expiration is read from its exp claim)
        const accessToken = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600, n: tokens });
        offlineTokens.push(accessToken);
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read_orders",
        });
      }
      if (form.get("subject_token") === "replayed" || exchangeFails) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: "online_token",
        token_type: "Bearer",
        expires_in: 600,
        scope: "read_orders",
        associated_user: { id: "staff1", roles: ["Manager"] },
        ...options.online,
      });
    }

    if (url === PB + "/api/permissions/me") {
      return new Response("{}", { status: onlineEnded ? 401 : 200 });
    }

    if (url.includes("/api/collections/orders/records")) {
      return Response.json({
        page: 1,
        perPage: 30,
        totalItems: 0,
        totalPages: 0,
        items: [],
        auth: init.headers.Authorization,
      });
    }

    throw new Error("unexpected request " + url);
  }) as typeof fetch;

  return {
    fetch: fetchFunc,
    requests,
    offlineTokens,
    tokenRequests: () => tokens,
    failExchange: () => {
      exchangeFails = true;
    },
    endOnlineSessions: () => {
      onlineEnded = true;
      exchangeFails = true;
    },
  };
}

function claims(extra: Record<string, any> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: HANDLE,
    iat: now,
    exp: now + 300,
    jti: "jti_" + Math.random().toString(36).slice(2),
    event: "application.installed",
    installation_id: "inst1",
    client_id: "pba_1",
    client_secret: "secret_1",
    webhook_secret: "whsec_1",
    token_endpoint: ISSUER + "/token",
    scopes: ["read_orders", "write_orders"],
    version: "1.0.0",
    ...extra,
  };
}

function notification(token: string, url = APP + "/install") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/jwt" },
    body: token,
  });
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Response) {
      return err.status;
    }
    throw err;
  }
  return 200;
}

function create(extra: Record<string, any> = {}) {
  const server = fakeServer(extra.server);
  const storage = new MemorySessionStorage();
  const app = detonator({
    appUrl: APP,
    handle: HANDLE,
    sessionStorage: storage,
    fetch: server.fetch,
    ...extra.options,
  });
  return { app, storage, server };
}

describe("authenticate.install()", function () {
  test("application.installed stores the installation (JWKS of the issuer) and responds 200", async function () {
    const { app, storage } = create();

    const result = await app.authenticate.install(notification(await signJWT(key, claims())));

    assert.equal(result.event, "application.installed");
    assert.equal(result.response.status, 200);
    const stored = await storage.loadInstallation(ISSUER, "inst1");
    assert.deepInclude(stored, {
      id: "inst1",
      issuer: ISSUER,
      url: PB,
      handle: HANDLE,
      clientId: "pba_1",
      clientSecret: "secret_1",
      webhookSecret: "whsec_1",
      version: "1.0.0",
    });
    assert.deepEqual(stored?.scopes, ["read_orders", "write_orders"]);
  });

  test("rejects a bad signature, a wrong audience, an expired token and a launch token", async function () {
    const { app, storage } = create();
    const now = Math.floor(Date.now() / 1000);

    assert.equal(
      await statusOf(app.authenticate.install(notification(await signJWT(otherKey, claims())))),
      401,
      "bad signature",
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(notification(await signJWT(key, claims({ aud: "other-app" })))),
      ),
      401,
      "wrong aud",
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(
          notification(await signJWT(key, claims({ iat: now - 900, exp: now - 600 }))),
        ),
      ),
      401,
      "expired",
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(
          notification(await signJWT(key, claims(), { typ: "pb-launch+jwt" })),
        ),
      ),
      401,
      "a launch token is not a notification",
    );
    assert.equal(
      await statusOf(app.authenticate.install(notification("not.a.jwt"))),
      401,
      "garbage",
    );
    assert.lengthOf(await storage.listInstallations(), 0);
  });

  test("rejects a replayed notification (jti)", async function () {
    const { app } = create();
    const token = await signJWT(key, claims({ jti: "same" }));

    assert.equal(await statusOf(app.authenticate.install(notification(token))), 200);
    assert.equal(await statusOf(app.authenticate.install(notification(token))), 409);
  });

  test("rejects the disallowed issuers (allowedIssuers, non https non loopback)", async function () {
    const allowed = create({
      options: { allowedIssuers: ["https://other.example.com/oauth2/_applicationInstallations"] },
    });
    assert.equal(
      await statusOf(allowed.app.authenticate.install(notification(await signJWT(key, claims())))),
      401,
    );
    assert.lengthOf(allowed.server.requests, 0, "the JWKS of a disallowed issuer is never fetched");

    const plain = "http://pb.example.com/oauth2/_applicationInstallations";
    const insecure = create({ server: { issuer: plain } });
    assert.equal(
      await statusOf(
        insecure.app.authenticate.install(notification(await signJWT(key, claims({ iss: plain })))),
      ),
      401,
    );

    const notInstallations = "https://pb.example.com/oauth2/users";
    assert.isFalse(insecure.app.isAllowedIssuer(notInstallations));
    assert.isTrue(
      insecure.app.isAllowedIssuer("http://127.0.0.1:8090/oauth2/_applicationInstallations"),
    );
    assert.isTrue(
      insecure.app.isAllowedIssuer("http://localhost:8090/oauth2/_applicationInstallations"),
    );
    assert.isFalse(insecure.app.isAllowedIssuer(42));

    // a loopback issuer is accepted
    const loopbackIssuer = "http://127.0.0.1:8090/oauth2/_applicationInstallations";
    const loopback = create({ server: { issuer: loopbackIssuer } });
    const result = await loopback.app.authenticate.install(
      notification(await signJWT(key, claims({ iss: loopbackIssuer }))),
    );
    assert.equal(result.installation.url, "http://127.0.0.1:8090");
  });

  test("credentials_rotated updates the secrets and ends the sessions; uninstalled deletes the installation", async function () {
    const { app, storage } = create();
    await app.authenticate.install(notification(await signJWT(key, claims())));
    await storage.storeSession({
      id: "s1",
      issuer: ISSUER,
      installationId: "inst1",
      accessToken: "t",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scope: "",
      staff: { id: "staff1", roles: [] },
      createdAt: "",
    });

    const rotated = await app.authenticate.install(
      notification(
        await signJWT(
          key,
          claims({
            event: "application.credentials_rotated",
            client_secret: "secret_2",
            webhook_secret: "whsec_2",
          }),
        ),
      ),
    );
    assert.equal(rotated.event, "application.credentials_rotated");
    const stored = await storage.loadInstallation(ISSUER, "inst1");
    assert.equal(stored?.clientSecret, "secret_2");
    assert.equal(stored?.webhookSecret, "whsec_2");
    assert.isUndefined(await storage.loadSession("s1"));

    const uninstalled = await app.authenticate.install(
      notification(
        await signJWT(
          key,
          claims({
            event: "application.uninstalled",
            client_secret: undefined,
            webhook_secret: undefined,
          }),
        ),
        APP + "/uninstall",
      ),
    );
    assert.equal(uninstalled.event, "application.uninstalled");
    assert.equal(uninstalled.installation.clientId, "pba_1");
    assert.isUndefined(await storage.loadInstallation(ISSUER, "inst1"));
  });

  test("method, missing secrets, missing installation and unknown events", async function () {
    const { app } = create();
    assert.equal(await statusOf(app.authenticate.install(new Request(APP + "/install"))), 405);
    assert.equal(
      await statusOf(
        app.authenticate.install(notification(await signJWT(key, claims({ client_secret: "" })))),
      ),
      400,
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(notification(await signJWT(key, claims({ installation_id: "" })))),
      ),
      400,
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(
          notification(await signJWT(key, claims({ event: "application.other" }))),
        ),
      ),
      400,
    );
    assert.equal(
      await statusOf(
        app.authenticate.install(notification(await signJWT(key, claims({ jti: "" })))),
      ),
      401,
    );
  });
});

async function install(app: ReturnType<typeof detonator>, extra: Record<string, any> = {}) {
  await app.authenticate.install(notification(await signJWT(key, claims(extra))));
}

describe("authenticate.public.appProxy()", function () {
  const SECRET = "wh-secret";

  async function proxyInstallation(storage: MemorySessionStorage, proxyPathPrefix?: string) {
    await storage.storeInstallation({
      id: "inst1",
      issuer: ISSUER,
      url: PB,
      handle: HANDLE,
      clientId: "client",
      clientSecret: "secret",
      webhookSecret: SECRET,
      scopes: [],
      version: "1.0.0",
      proxyPathPrefix,
      installedAt: "",
      updatedAt: "",
    });
  }

  async function signed(
    params: Record<string, string | Array<string>> = {},
    body = "",
    overrides: Record<string, string> = {},
  ): Promise<URLSearchParams> {
    const query = new URLSearchParams();
    const all: Record<string, string | Array<string>> = {
      issuer: ISSUER,
      logged_in_customer_id: "",
      path_prefix: "/apps/reviews",
      timestamp: String(Math.floor(Date.now() / 1000)),
      body_sha256: await sha256Hex(new TextEncoder().encode(body)),
      ...params,
      ...overrides,
    };
    for (const [k, v] of Object.entries(all)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        query.append(k, item);
      }
    }
    query.set("signature", await signAppProxyQuery(query, SECRET));
    return query;
  }

  function app(storage: MemorySessionStorage) {
    return detonator({
      appUrl: APP,
      handle: HANDLE,
      sessionStorage: storage,
      fetch: fakeServer().fetch,
    });
  }

  async function expect401(promise: Promise<unknown>, message: string) {
    const err = await promise.then(
      () => null,
      (e) => e,
    );
    assert.instanceOf(err, Response);
    assert.equal(err.status, 401);
    assert.include(await err.text(), message);
  }

  test("verifies the raw query (empty and repeated params) and returns the context", async function () {
    const storage = new MemorySessionStorage();
    await proxyInstallation(storage, "/apps/reviews");

    const query = await signed({ a: ["1", "2"], empty: "" }, "payload", {
      logged_in_customer_id: "c1",
    });
    const raw = query.toString().replace("empty=&", "empty&");
    const context = await app(storage).authenticate.public.appProxy(
      new Request(APP + "/proxy/x?" + raw, { method: "POST", body: "payload" }),
    );

    assert.equal(context.installation.id, "inst1");
    assert.equal(context.customerId, "c1");
    assert.equal(context.pathPrefix, "/apps/reviews");
    assert.isFunction(context.admin.collection);
  });

  test("the path comes with the notifications and a verified request updates a missed change", async function () {
    const storage = new MemorySessionStorage();
    await proxyInstallation(storage, "/apps/old");

    await app(storage).authenticate.public.appProxy(
      new Request(APP + "/proxy?" + (await signed())),
    );
    assert.equal(
      (await storage.loadInstallation(ISSUER, "inst1"))?.proxyPathPrefix,
      "/apps/reviews",
    );
  });

  test("rejects a tampered query/body, replay outside the window and forged/unknown params", async function () {
    const storage = new MemorySessionStorage();
    await proxyInstallation(storage, "/apps/reviews");
    const { authenticate } = app(storage);

    // tampered query
    const tampered = await signed({ a: "1" });
    tampered.set("a", "2");
    await expect401(
      authenticate.public.appProxy(new Request(APP + "/proxy?" + tampered)),
      "signature",
    );

    // tampered customer (reserved param spoofing)
    const spoofed = await signed();
    spoofed.set("logged_in_customer_id", "admin");
    await expect401(
      authenticate.public.appProxy(new Request(APP + "/proxy?" + spoofed)),
      "signature",
    );

    // missing (dropped) param
    const dropped = await signed({ a: "1" });
    dropped.delete("a");
    await expect401(
      authenticate.public.appProxy(new Request(APP + "/proxy?" + dropped)),
      "signature",
    );

    // tampered body
    await expect401(
      authenticate.public.appProxy(
        new Request(APP + "/proxy?" + (await signed({}, "original")), {
          method: "POST",
          body: "changed",
        }),
      ),
      "signature",
    );

    // replay outside of the window (with a valid signature)
    for (const delta of [-91, 91]) {
      const replayed = await signed({}, "", {
        timestamp: String(Math.floor(Date.now() / 1000) + delta),
      });
      await expect401(
        authenticate.public.appProxy(new Request(APP + "/proxy?" + replayed)),
        "signature",
      );
    }

    // inside of the window
    const inside = await signed({}, "", {
      timestamp: String(Math.floor(Date.now() / 1000) - 80),
    });
    await authenticate.public.appProxy(new Request(APP + "/proxy?" + inside));

    // no signature, untrusted and unknown issuer
    await expect401(
      authenticate.public.appProxy(
        new Request(
          APP + "/proxy?issuer=" + encodeURIComponent(ISSUER) + "&path_prefix=/apps/reviews",
        ),
      ),
      "signature",
    );
    await expect401(
      authenticate.public.appProxy(new Request(APP + "/proxy")),
      "Not an application proxy",
    );
    const unknownIssuer = await signed({}, "", {
      issuer: "https://other.example.com/oauth2/_applicationInstallations",
    });
    await expect401(
      authenticate.public.appProxy(new Request(APP + "/proxy?" + unknownIssuer)),
      "Unknown",
    );
  });

  test("application.app_proxy_updated stores the new path", async function () {
    const storage = new MemorySessionStorage();
    await proxyInstallation(storage, "/apps/reviews");
    const now = Math.floor(Date.now() / 1000);

    const token = await signJWT(key, {
      iss: ISSUER,
      aud: HANDLE,
      iat: now,
      exp: now + 300,
      jti: "proxy-updated",
      event: "application.app_proxy_updated",
      installation_id: "inst1",
      app_proxy_path_prefix: "/tools/custom",
    });

    const { event } = await app(storage).authenticate.install(
      new Request(APP + "/install", { method: "POST", body: token }),
    );
    assert.equal(event, "application.app_proxy_updated");
    assert.equal(
      (await storage.loadInstallation(ISSUER, "inst1"))?.proxyPathPrefix,
      "/tools/custom",
    );
  });
});

describe("authenticate.webhook()", function () {
  test("verifies the HMAC with the installation webhook secret and returns the installation and its admin client", async function () {
    const { app, server } = create();
    await install(app);
    await install(app, {
      installation_id: "inst2",
      client_id: "pba_2",
      client_secret: "s2",
      webhook_secret: "whsec_2",
    });

    const body = JSON.stringify({
      action: "create",
      collectionName: "orders",
      record: { id: "o1", title: "Order" },
    });
    const request = new Request(APP + "/webhooks/orders/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PB-Topic": "orders.create",
        "X-PB-Event-Id": "evt1",
        "X-PB-Webhook-Id": "wh1",
        "X-PB-Triggered-At": "2026-10-29T10:00:00Z",
        "X-PB-Api-Version": "2026-10",
        "X-PB-Issuer": ISSUER,
        "X-PB-Application-Installation": "inst2",
        "X-PB-Hmac-Sha256": await signWebhookBody(body, "whsec_2"),
      },
      body,
    });

    const result = await app.authenticate.webhook(request);
    assert.equal(result.topic, "orders.create");
    assert.equal(result.eventId, "evt1");
    assert.equal(result.webhookId, "wh1");
    assert.equal(result.triggeredAt, "2026-10-29T10:00:00Z");
    assert.equal(result.apiVersion, "2026-10");
    assert.deepEqual(result.payload, {
      action: "create",
      collectionName: "orders",
      record: { id: "o1", title: "Order" },
    });
    assert.equal(result.installation.id, "inst2", "the installation of the delivery headers");

    const list = await result.admin.collection("orders").getList();
    assert.equal(
      (list as any).auth,
      server.offlineTokens[0],
      "the offline admin client (client_credentials)",
    );
    assert.equal(server.tokenRequests(), 1);
  });

  test("rejects a wrong signature, a tampered body, missing/unknown installation headers and the other methods", async function () {
    const { app } = create();
    await install(app);

    const body = JSON.stringify({ action: "create", record: {} });
    const sign = await signWebhookBody(body, "whsec_1");
    const make = (b: string, signature: string, headers: Record<string, string> = {}) =>
      new Request(APP + "/webhooks", {
        method: "POST",
        headers: {
          "X-PB-Issuer": ISSUER,
          "X-PB-Application-Installation": "inst1",
          "X-PB-Hmac-Sha256": signature,
          ...headers,
        },
        body: b,
      });

    assert.equal(await statusOf(app.authenticate.webhook(make(body, sign))), 200);
    assert.equal(
      await statusOf(app.authenticate.webhook(make(body, await signWebhookBody(body, "other")))),
      401,
    );
    assert.equal(
      await statusOf(app.authenticate.webhook(make(body.replace("{}", '{"x":1}'), sign))),
      401,
    );
    assert.equal(await statusOf(app.authenticate.webhook(make(body, ""))), 401);
    assert.equal(
      await statusOf(
        app.authenticate.webhook(make(body, sign, { "X-PB-Application-Installation": "" })),
      ),
      401,
      "missing installation header",
    );
    assert.equal(
      await statusOf(app.authenticate.webhook(make(body, sign, { "X-PB-Issuer": "" }))),
      401,
      "missing issuer header",
    );
    assert.equal(
      await statusOf(
        app.authenticate.webhook(make(body, sign, { "X-PB-Application-Installation": "nope" })),
      ),
      401,
      "unknown installation",
    );
    assert.equal(
      await statusOf(
        app.authenticate.webhook(
          make(body, sign, {
            "X-PB-Issuer": "https://other.example.com/oauth2/_applicationInstallations",
          }),
        ),
      ),
      401,
      "unknown issuer",
    );
    assert.equal(await statusOf(app.authenticate.webhook(new Request(APP + "/webhooks"))), 405);
    assert.equal(
      await statusOf(
        app.authenticate.webhook(make("not json", await signWebhookBody("not json", "whsec_1"))),
      ),
      400,
    );
  });

  test("verifies ONE HMAC with the installation of the headers (no scan of the other installations)", async function () {
    const { app, storage } = create();
    await install(app); // inst1 / whsec_1
    await install(app, {
      installation_id: "inst2",
      client_id: "pba_2",
      client_secret: "s2",
      webhook_secret: "whsec_2",
    });

    // spy the storage reads during the webhook handling
    const calls: Array<string> = [];
    const load = storage.loadInstallation.bind(storage);
    storage.loadInstallation = async (issuer, id) => {
      calls.push("load:" + id);
      return load(issuer, id);
    };
    const list = storage.listInstallations.bind(storage);
    storage.listInstallations = async () => {
      calls.push("list");
      return list();
    };
    const find = storage.findInstallationsByIssuer.bind(storage);
    storage.findInstallationsByIssuer = async (issuer) => {
      calls.push("find");
      return find(issuer);
    };

    // signed with inst2's secret but addressed to inst1: rejected (inst2 is never tried)
    const body = JSON.stringify({ action: "create", record: { id: "o1" } });
    const request = new Request(APP + "/webhooks", {
      method: "POST",
      headers: {
        "X-PB-Issuer": ISSUER,
        "X-PB-Application-Installation": "inst1",
        "X-PB-Hmac-Sha256": await signWebhookBody(body, "whsec_2"),
      },
      body,
    });

    assert.equal(await statusOf(app.authenticate.webhook(request)), 401);
    assert.deepEqual(calls, ["load:inst1"], "a single installation lookup, no listing");
  });
});

function launchRequest(token: string, path = "/app") {
  return new Request(APP + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ launch_token: token }).toString(),
  });
}

async function launchToken(
  extra: Record<string, any> = {},
  header: Record<string, any> = { typ: "pb-launch+jwt" },
) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    key,
    {
      iss: ISSUER,
      aud: "pba_1",
      sub: "staff1",
      sid: "sess1",
      installation_id: "inst1",
      extension: "home",
      iat: now,
      exp: now + 60,
      jti: "launch_" + Math.random().toString(36).slice(2),
      ...extra,
    },
    header,
  );
}

async function sessionToken(extra: Record<string, any> = {}, header: Record<string, any> = {}) {
  return launchToken(extra, { typ: "pb-session+jwt", ...header });
}

function frameRequest(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers: { "sec-fetch-dest": "iframe", ...headers } });
}

describe("authenticate.launch() / authenticate.admin()", function () {
  test("launch: verify + token exchange (no cookies) -> redirect with the issuer", async function () {
    const { app, storage, server } = create();
    await install(app);

    const result = await app.authenticate.launch(
      launchRequest(
        await launchToken({
          extension: "order-inspect",
          record: { collection: "orders", id: "o1" },
        }),
        "/app/record",
      ),
    );
    assert.equal(result.staff.id, "staff1");
    assert.deepEqual(result.staff.roles, ["Manager"]);
    assert.equal(result.extension, "order-inspect");
    assert.deepEqual(result.record, { collection: "orders", id: "o1" });
    assert.equal(result.admin.authStore.token, "online_token");

    const exchange = server.requests.find((r) => r.url === ISSUER + "/token")!;
    const form = new URLSearchParams(String(exchange.init.body));
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(
      form.get("subject_token_type"),
      "urn:pocketbase:params:oauth:token-type:launch_token",
    );
    assert.equal(exchange.init.headers.Authorization, "Basic " + btoa("pba_1:secret_1"));

    const redirect = result.redirect();
    assert.equal(redirect.status, 303);
    assert.equal(
      redirect.headers.get("location"),
      "/app/record?issuer=" + encodeURIComponent(ISSUER),
    );
    assert.isNull(redirect.headers.get("set-cookie"), "no cookies");
    assert.equal(result.redirect("/app").headers.get("location"), "/app");

    assert.equal(
      (await storage.loadSession(ISSUER + "\ninst1\nsess1"))?.accessToken,
      "online_token",
    );
  });

  test("launch rejects: wrong audience, wrong typ, replay, unknown installation, disallowed issuer, GET", async function () {
    const { app } = create();
    await install(app);

    assert.equal(
      await statusOf(
        app.authenticate.launch(launchRequest(await launchToken({ aud: "pba_other" }))),
      ),
      401,
    );
    assert.equal(
      await statusOf(app.authenticate.launch(launchRequest(await launchToken({}, { typ: "JWT" })))),
      401,
    );
    assert.equal(
      await statusOf(app.authenticate.launch(launchRequest(await sessionToken()))),
      401,
      "a session token isn't a launch token",
    );
    assert.equal(
      await statusOf(
        app.authenticate.launch(launchRequest(await launchToken({ installation_id: "nope" }))),
      ),
      401,
    );
    assert.equal(
      await statusOf(
        app.authenticate.launch(
          launchRequest(
            await launchToken({ iss: "https://evil.example.com/oauth2/_applicationInstallations" }),
          ),
        ),
      ),
      401,
    );

    const token = await launchToken({ jti: "once" });
    assert.equal(await statusOf(app.authenticate.launch(launchRequest(token))), 200);
    assert.equal(await statusOf(app.authenticate.launch(launchRequest(token))), 401, "replay");

    assert.equal(await statusOf(app.authenticate.launch(new Request(APP + "/app"))), 405);
    assert.equal(await statusOf(app.authenticate.launch(launchRequest(""))), 401);
  });

  test("admin(): the bearer session token -> online session keyed by (installation, sid), exchanged once", async function () {
    const { app, server, storage } = create();
    await install(app);

    const token = await sessionToken({
      sid: "sess-a",
      extension: "order-inspect",
      record: { collection: "orders", id: "o1" },
    });
    const request = () =>
      new Request(APP + "/app", { headers: { authorization: "Bearer " + token } });

    // the concurrent loaders of a request exchange only once
    const [first, second] = await Promise.all([
      app.authenticate.admin(request()),
      app.authenticate.admin(request()),
    ]);
    assert.equal(first.admin.authStore.token, "online_token");
    assert.equal(second.admin.authStore.token, "online_token");
    assert.equal(first.admin.authStore.meta.associatedUser?.id, "staff1");
    assert.isNull(first.admin.authStrategy, "no silent refresh");
    assert.equal(first.installation.id, "inst1");
    assert.equal(first.extension, "order-inspect");
    assert.deepEqual(first.record, { collection: "orders", id: "o1" });

    const exchanges = () => server.requests.filter((r) => r.url === ISSUER + "/token");
    assert.lengthOf(exchanges(), 1);
    assert.equal(
      new URLSearchParams(String(exchanges()[0].init.body)).get("subject_token_type"),
      "urn:pocketbase:params:oauth:token-type:session_token",
    );

    // a renewed token of the same staff session reuses the stored online session
    await app.authenticate.admin(
      new Request(APP + "/app", {
        headers: { authorization: "Bearer " + (await sessionToken({ sid: "sess-a" })) },
      }),
    );
    assert.lengthOf(exchanges(), 1);

    // another staff session and an expired online session -> a new exchange
    await app.authenticate.admin(
      new Request(APP + "/app", {
        headers: { authorization: "Bearer " + (await sessionToken({ sid: "sess-b" })) },
      }),
    );
    assert.lengthOf(exchanges(), 2);

    const stored = (await storage.loadSession(ISSUER + "\ninst1\nsess-a"))!;
    await storage.storeSession({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 1 });
    await app.authenticate.admin(
      new Request(APP + "/app", {
        headers: { authorization: "Bearer " + (await sessionToken({ sid: "sess-a" })) },
      }),
    );
    assert.lengthOf(exchanges(), 3);
  });

  test("admin(): the id_token param after the bounce", async function () {
    const { app } = create();
    await install(app);

    const context = await app.authenticate.admin(
      frameRequest(APP + "/app?id_token=" + (await sessionToken())),
    );
    assert.equal(context.installation.id, "inst1");
  });

  test("admin(): invalid tokens -> bounce (document), 401 retry (data), outside frame page (top level)", async function () {
    const { app } = create();
    await install(app);

    const invalid = [
      "",
      "nope",
      await launchToken(),
      await sessionToken({ aud: "other" }),
      await sessionToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await sessionToken({ installation_id: "nope" }),
      await sessionToken({ iss: "https://evil.example.com/oauth2/_applicationInstallations" }),
    ];

    for (const token of invalid) {
      const auth: Record<string, string> = token ? { authorization: "Bearer " + token } : {};

      // data request (fetch)
      const data = await app.authenticate
        .admin(new Request(APP + "/app.data", { headers: { "sec-fetch-dest": "empty", ...auth } }))
        .catch((e) => e);
      assert.instanceOf(data, Response);
      assert.equal(data.status, 401);
      assert.equal(data.headers.get("x-detcord-reauthorize"), "1");

      // the iframe document: only a document without a token bounces (a rejected id_token can't loop)
      const bounce = await app.authenticate
        .admin(frameRequest(APP + "/app" + (token ? "?id_token=" + token : "")))
        .catch((e) => e);
      const html = await bounce.text();
      assert.equal(bounce.headers.get("referrer-policy"), "no-referrer");
      assert.notInclude(html, token || "no token in the page");
      if (token) {
        assert.equal(bounce.status, 401);
        assert.equal(bounce.headers.get("x-detcord-reauthorize"), "1");
        assert.include(html, 'id="detonator-session-ended"');
        assert.include(html, "detcord.sessionEnded()");
      } else {
        assert.equal(bounce.status, 200);
        assert.include(html, 'id="detonator-bounce"');
        assert.include(html, 'searchParams.set("id_token"');
        assert.include(html, "window.detcord");
      }

      // top level (outside of the iframe)
      const outside = await app.authenticate
        .admin(new Request(APP + "/app", { headers: { "sec-fetch-dest": "document", ...auth } }))
        .catch((e) => e);
      assert.equal(outside.status, 200);
      assert.include(await outside.text(), PB + "/_/#/apps/" + HANDLE);
    }
  });

  test("admin(): the exchange failure (e.g. logged out) of a valid token -> retry/bounce", async function () {
    const { app, server } = create();
    await install(app);

    server.failExchange();
    const err = await app.authenticate
      .admin(
        new Request(APP + "/app", {
          headers: {
            authorization: "Bearer " + (await sessionToken({ sid: "failing" })),
            "sec-fetch-dest": "empty",
          },
        }),
      )
      .catch((e) => e);
    assert.instanceOf(err, Response);
    assert.equal(err.status, 401);
    assert.equal(err.headers.get("x-detcord-reauthorize"), "1");
  });

  test("addDocumentResponseHeaders(): frame-ancestors from the verified token or the known issuer", async function () {
    const { app } = create();
    await install(app);

    const headersOf = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers();
      await app.addDocumentResponseHeaders(new Request(url, init), headers);
      return headers;
    };

    const fromToken = await headersOf(APP + "/app?id_token=" + (await sessionToken()));
    assert.equal(fromToken.get("content-security-policy"), "frame-ancestors " + PB);
    assert.equal(fromToken.get("referrer-policy"), "no-referrer");

    const fromBearer = await headersOf(APP + "/app", {
      headers: { authorization: "Bearer " + (await sessionToken()) },
    });
    assert.equal(fromBearer.get("content-security-policy"), "frame-ancestors " + PB);

    const fromIssuer = await headersOf(APP + "/app?issuer=" + encodeURIComponent(ISSUER));
    assert.equal(fromIssuer.get("content-security-policy"), "frame-ancestors " + PB);

    // an issuer of another instance isn't echoed
    const forged = await headersOf(
      APP +
        "/app?issuer=" +
        encodeURIComponent("https://evil.example.com/oauth2/_applicationInstallations"),
    );
    assert.isNull(forged.get("content-security-policy"));

    // a forged token neither
    const forgedToken = await launchToken({ iss: ISSUER }, { typ: "pb-session+jwt" });
    const tampered = forgedToken.slice(0, -4) + "AAAA";
    assert.isNull(
      (await headersOf(APP + "/app?id_token=" + tampered)).get("content-security-policy"),
    );
  });

  test("withoutIdToken()", function () {
    const moved = withoutIdToken(
      new Request("http://app/app/users/1?a=1&id_token=TOK", { headers: { "x-other": "1" } }),
    );
    assert.equal(moved.url, "http://app/app/users/1?a=1");
    assert.equal(moved.headers.get("authorization"), "Bearer TOK");
    assert.equal(moved.headers.get("x-other"), "1");

    const none = new Request("http://app/app");
    assert.equal(withoutIdToken(none), none);

    // only a document load: a request with a body stays untouched
    const post = new Request("http://app/app?id_token=TOK", { method: "POST", body: "x" });
    assert.equal(withoutIdToken(post), post);
  });

  test("redactIdToken()", function () {
    assert.equal(redactIdToken("/app?a=1&id_token=SECRET&b=2"), "/app?a=1&id_token=REDACTED&b=2");
    assert.equal(redactIdToken("/app?id_token=SECRET"), "/app?id_token=REDACTED");
    assert.equal(redactIdToken("/app"), "/app");
  });

  test("relaunchResponse()", function () {
    assert.equal(relaunchResponse().headers.get("cache-control"), "no-store");
  });
});

describe("handleLaunch() / handleEmbeddedRequest()", function () {
  test("handles only the launch POSTs (redirect or relaunch page) and leaves the other requests to the router", async function () {
    const { app } = create();
    await install(app);

    const ok = await app.handleLaunch(launchRequest(await launchToken(), "/app/record"));
    assert.equal(ok?.status, 303);
    assert.equal(ok?.headers.get("location"), "/app/record?issuer=" + encodeURIComponent(ISSUER));
    assert.isNull(ok?.headers.get("set-cookie"));

    const invalid = await app.handleLaunch(launchRequest(await launchToken({ aud: "other" })));
    assert.equal(invalid?.status, 401);
    assert.include(await invalid!.text(), "Open the application again");

    assert.isNull(await app.handleLaunch(new Request(APP + "/app")));
    assert.isNull(
      await app.handleLaunch(
        new Request(APP + "/app", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "other=1",
        }),
      ),
    );
  });

  test("handleEmbeddedRequest(): no liveness probe; the exchange failure -> 401 with the reauthorize header", async function () {
    const { app, server } = create();
    await install(app);
    const config = { paths: ["/app"] };
    const data = async (sid: string) =>
      new Request(APP + "/app/additional.data", {
        headers: {
          "sec-fetch-dest": "empty",
          authorization: "Bearer " + (await sessionToken({ sid })),
        },
      });

    assert.isNull(await app.handleEmbeddedRequest(await data("sess-live"), config));
    assert.isNull(await app.handleEmbeddedRequest(await data("sess-live"), config));
    assert.isEmpty(
      server.requests.filter((r) => r.url.endsWith("/api/permissions/me")),
      "no probe request",
    );

    server.failExchange();
    const ended = await app.handleEmbeddedRequest(await data("sess-new"), config);
    assert.equal(ended?.status, 401);
    assert.equal(ended?.headers.get("X-Detcord-Reauthorize"), "1");

    // a document gets the ended page (it can't loop through the bounce)
    const page = await app.handleEmbeddedRequest(
      frameRequest(APP + "/app?id_token=" + (await sessionToken({ sid: "sess-new" }))),
      config,
    );
    assert.equal(page?.status, 401);
    assert.include(await page!.text(), "detcord.sessionEnded()");
  });

  test("the online admin client: the first rejected call deletes the session and throws the 401 Response", async function () {
    const { app, server, storage } = create();
    await install(app);
    const id = ISSUER + "\ninst1\nsess-admin";
    const context = await app.authenticate.admin(
      new Request(APP + "/app", {
        headers: {
          "sec-fetch-dest": "empty",
          authorization: "Bearer " + (await sessionToken({ sid: "sess-admin" })),
        },
      }),
    );

    await context.admin.send("/api/permissions/me", { requestKey: null });
    assert.isDefined(await storage.loadSession(id));

    server.endOnlineSessions();

    const err = await context.admin
      .send("/api/permissions/me", { requestKey: null })
      .catch((e: unknown) => e);
    assert.instanceOf(err, Response);
    assert.equal((err as Response).status, 401);
    assert.equal((err as Response).headers.get("X-Detcord-Reauthorize"), "1");
    assert.isUndefined(await storage.loadSession(id));

    // the same through the record services
    const list = await context.admin
      .collection("orders")
      .getList(1, 1)
      .catch((e: unknown) => e);
    assert.notInstanceOf(list, Error);
  });

  test("handleEmbeddedRequest(): the paths, the tokens and the frame-ancestors of the bounce", async function () {
    const { app } = create();
    await install(app);
    const config = { paths: ["/app"] };

    // not an embedded path
    assert.isNull(await app.handleEmbeddedRequest(new Request(APP + "/install"), config));
    assert.isNull(await app.handleEmbeddedRequest(new Request(APP + "/appendix"), config));

    // a valid token -> the router
    assert.isNull(
      await app.handleEmbeddedRequest(
        frameRequest(APP + "/app/additional?id_token=" + (await sessionToken())),
        config,
      ),
    );

    // launches
    const launched = await app.handleEmbeddedRequest(
      launchRequest(await launchToken(), "/app"),
      config,
    );
    assert.equal(launched?.status, 303);

    // the bounce (with the known issuer) and the data requests
    const bounce = await app.handleEmbeddedRequest(
      frameRequest(APP + "/app?issuer=" + encodeURIComponent(ISSUER)),
      config,
    );
    assert.equal(bounce?.status, 200);
    assert.equal(bounce?.headers.get("content-security-policy"), "frame-ancestors " + PB);

    const data = await app.handleEmbeddedRequest(
      new Request(APP + "/app/additional.data", { headers: { "sec-fetch-dest": "empty" } }),
      config,
    );
    assert.equal(data?.status, 401);
    assert.equal(data?.headers.get("x-detcord-reauthorize"), "1");

    const outside = await app.handleEmbeddedRequest(
      new Request(APP + "/app", { headers: { "sec-fetch-dest": "document" } }),
      config,
    );
    assert.equal(outside?.status, 200);
    assert.include(await outside!.text(), "detonator-dashboard-link");
  });
});

describe("unauthenticated.admin()", function () {
  test("the offline client of an instance (client_credentials, fetched once and reused)", async function () {
    const { app, server } = create();
    await install(app);

    const { admin, installation } = await app.unauthenticated.admin(ISSUER);
    assert.equal(installation.id, "inst1");
    await admin.collection("orders").getList();
    await admin.collection("orders").getList();
    assert.equal(server.tokenRequests(), 1, "the token is reused until it expires");
    assert.equal((await app.unauthenticated.admin()).admin, admin, "the client is cached");

    await expect(
      app.unauthenticated.admin("https://other.example.com/oauth2/_applicationInstallations"),
    ).rejects.toThrow(/No installation/);
  });

  test("ambiguous without an issuer; the custom app env credentials (static installation)", async function () {
    const server = fakeServer();
    const storage = new MemorySessionStorage();
    const app = detonator({
      appUrl: APP,
      handle: HANDLE,
      sessionStorage: storage,
      fetch: server.fetch,
      url: PB + "/",
      clientId: "pba_env",
      clientSecret: "secret_env",
      webhookSecret: "whsec_env",
      installationId: "inst_env",
    });

    const { installation } = await app.unauthenticated.admin();
    assert.deepInclude(installation, {
      id: "inst_env",
      issuer: ISSUER,
      url: PB,
      clientId: "pba_env",
    } as Partial<Installation>);

    // the static installation verifies the webhooks too
    const body = JSON.stringify({ action: "create", record: { id: "x" } });
    const hook = await app.authenticate.webhook(
      new Request(APP + "/webhooks", {
        method: "POST",
        headers: {
          "X-PB-Issuer": ISSUER,
          "X-PB-Application-Installation": "inst_env",
          "X-PB-Hmac-Sha256": await signWebhookBody(body, "whsec_env"),
        },
        body,
      }),
    );
    assert.equal(hook.installation.id, "inst_env");

    await storage.storeInstallation({ ...installation, id: "inst_other", clientId: "pba_o" });
    await expect(app.unauthenticated.admin()).rejects.toThrow(/Multiple installations/);
  });
});

describe("helpers", function () {
  beforeEach(() => clearJWKSCache());

  test("decodeJWT() and the required handle", async function () {
    const token = await signJWT(key, { a: 1 }, { typ: "x" });
    assert.deepEqual(decodeJWT(token).claims, { a: 1 });
    assert.equal(decodeJWT(token).header.typ, "x");
    assert.deepEqual(decodeJWT("bad"), { header: {}, claims: {} });
    assert.deepEqual(decodeJWT("a.b.c"), { header: {}, claims: {} });

    assert.throws(
      () => detonator({ appUrl: APP, handle: "", sessionStorage: new MemorySessionStorage() }),
      /handle/,
    );
  });
});
