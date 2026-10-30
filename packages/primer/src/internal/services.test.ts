import { describe, assert, expect, test, beforeAll, afterAll, afterEach } from "vitest";
import { FetchMock } from "../test-utils/mocks";
import { DashboardClient } from "./client";
import { RoleService } from "./roles";
import { OAuth2ClientService } from "./oauth2-clients";
import { WebhookService } from "./webhooks";
import { LLMService } from "./llm";
import { ApplicationService } from "./applications";
import { SessionService } from "./sessions";

const base = "http://test.local";

type Expected = {
  method: string;
  path: string;
  body?: any;
  contentType?: string;
  reply?: any;
  replyCode?: number;
};

describe("admin services", function () {
  const fetchMock = new FetchMock();
  const client = new DashboardClient(base);

  beforeAll(function () {
    fetchMock.init();
  });

  afterAll(function () {
    fetchMock.restore();
  });

  afterEach(function () {
    fetchMock.clearMocks();
  });

  function expectRequest(e: Expected) {
    fetchMock.on({
      method: e.method,
      url: base + e.path,
      additionalMatcher: (_, config: any) => {
        if (e.contentType && config.headers["Content-Type"] !== e.contentType) {
          return false;
        }
        if (e.body !== undefined) {
          const raw =
            typeof config.body === "string" && config.headers["Content-Type"] === "application/json"
              ? JSON.parse(config.body)
              : config.body;
          return JSON.stringify(raw) === JSON.stringify(e.body);
        }
        return true;
      },
      replyCode: e.replyCode || 200,
      replyBody: e.reply === undefined ? {} : e.reply,
    });
  }

  test("services are registered on the client", function () {
    assert.instanceOf(client.roles, RoleService);
    assert.instanceOf(client.oauth2Clients, OAuth2ClientService);
    assert.instanceOf(client.webhooks, WebhookService);
    assert.instanceOf(client.llm, LLMService);
    assert.instanceOf(client.applications, ApplicationService);
    assert.instanceOf(client.sessions, SessionService);
  });

  describe("RoleService", function () {
    test("registry, assignments, me and records CRUD path", async function () {
      assert.equal(client.roles.baseCrudPath, "/api/collections/_roles/records");

      expectRequest({ method: "GET", path: "/api/roles", reply: { items: [] } });
      assert.deepEqual(await client.roles.registry(), { items: [] } as any);

      expectRequest({
        method: "GET",
        path: "/api/roles/assignments?collection=users&record=r1",
        reply: { roles: ["a"] },
      });
      assert.deepEqual((await client.roles.getAssignments("users", "r1")).roles, ["a"]);

      expectRequest({
        method: "PUT",
        path: "/api/roles/assignments",
        body: { collection: "users", record: "r1", roles: ["a", "b"] },
        reply: { roles: ["a", "b"] },
      });
      await client.roles.setAssignments("users", "r1", ["a", "b"]);

      expectRequest({
        method: "GET",
        path: "/api/permissions/me",
        reply: { kind: "staff" },
      });
      assert.equal((await client.roles.me()).kind, "staff");
    });
  });

  describe("OAuth2ClientService", function () {
    test("secret and signing key rotation", async function () {
      assert.equal(client.oauth2Clients.baseCrudPath, "/api/collections/_oauth2Clients/records");

      expectRequest({
        method: "POST",
        path: "/api/oauth2/clients/c%2F1/rotate-secret",
        reply: { clientId: "x", clientSecret: "s" },
      });
      assert.equal((await client.oauth2Clients.rotateSecret("c/1")).clientSecret, "s");

      expectRequest({
        method: "POST",
        path: "/api/oauth2/users/keys/rotate",
        body: { alg: "ES256" },
        reply: { id: "col" },
      });
      await client.oauth2Clients.rotateSigningKey("users", "ES256");
    });

    test("API keys", async function () {
      const keys = client.oauth2Clients.apiKeys("c1");
      const path = "/api/oauth2/clients/c1/api-keys";

      expectRequest({ method: "GET", path, reply: [{ id: "k1" }] });
      assert.equal((await keys.getFullList())[0].id, "k1");

      expectRequest({
        method: "POST",
        path,
        body: { name: "store", kind: "private", buyerContext: "none" },
        reply: { apiKey: { id: "k2" }, token: "pb_sk_x" },
      });
      assert.equal(
        (
          await keys.create({
            name: "store",
            kind: "private",
            buyerContext: "none",
          })
        ).token,
        "pb_sk_x",
      );

      expectRequest({
        method: "PATCH",
        path: path + "/k2",
        body: { disabled: true },
        reply: { id: "k2", disabled: true },
      });
      assert.isTrue((await keys.update("k2", { disabled: true })).disabled);

      expectRequest({
        method: "POST",
        path: path + "/k2/rotate-secret",
        reply: { apiKey: { id: "k2" }, token: "pb_sk_y" },
      });
      assert.equal((await keys.rotateSecret("k2")).token, "pb_sk_y");

      expectRequest({ method: "DELETE", path: path + "/k2", replyCode: 204 });
      assert.isTrue(await keys.delete("k2"));
    });
  });

  describe("WebhookService", function () {
    test("subscriptions and deliveries", async function () {
      assert.equal(client.webhooks.baseCrudPath, "/api/collections/_webhooks/records");

      expectRequest({
        method: "GET",
        path: "/api/webhooks/topics",
        reply: { custom: [] },
      });
      await client.webhooks.topics();

      expectRequest({
        method: "GET",
        path: "/api/webhooks/subscriptions/w1/secret",
        reply: { id: "w1", secret: "s" },
      });
      assert.equal((await client.webhooks.revealSecret("w1")).secret, "s");

      expectRequest({
        method: "POST",
        path: "/api/webhooks/subscriptions/w1/rotate-secret",
        reply: { id: "w1", secret: "s2" },
      });
      assert.equal((await client.webhooks.rotateSecret("w1")).secret, "s2");

      expectRequest({
        method: "POST",
        path: "/api/webhooks/subscriptions/w1/test",
        body: { topic: "posts.create" },
        reply: { id: "d1" },
      });
      await client.webhooks.test("w1", "posts.create");

      expectRequest({
        method: "GET",
        path: "/api/webhooks/deliveries?page=2&perPage=10&filter=status%3D'failed'",
        reply: { items: [] },
      });
      await client.webhooks.deliveries.getList(2, 10, {
        filter: "status='failed'",
      });

      expectRequest({
        method: "GET",
        path: "/api/webhooks/deliveries/d1",
        reply: { id: "d1" },
      });
      await client.webhooks.deliveries.getOne("d1");

      expectRequest({
        method: "GET",
        path: "/api/webhooks/deliveries/stats?interval=hour&groupBy=status",
        reply: [],
      });
      await client.webhooks.deliveries.getStats({
        interval: "hour",
        groupBy: "status",
      });

      expectRequest({
        method: "POST",
        path: "/api/webhooks/deliveries/d1/redeliver",
        reply: { id: "d2" },
      });
      assert.equal((await client.webhooks.deliveries.redeliver("d1")).id, "d2");

      expectRequest({
        method: "DELETE",
        path: "/api/webhooks/deliveries",
        replyCode: 204,
      });
      assert.isTrue(await client.webhooks.deliveries.truncate());
    });
  });

  describe("LLMService", function () {
    test("chat, providers, test and logs", async function () {
      expectRequest({
        method: "POST",
        path: "/api/llm/support/chat",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        reply: { text: "hello" },
      });
      assert.equal(
        (
          await client.llm.chat("support", {
            messages: [{ role: "user", content: "hi" }],
          })
        ).text,
        "hello",
      );

      expectRequest({
        method: "GET",
        path: "/api/llm/providers",
        reply: { drivers: [] },
      });
      await client.llm.providers();

      expectRequest({
        method: "POST",
        path: "/api/llm/test",
        body: { name: "p1", prompt: "x" },
        reply: { ok: true },
      });
      await client.llm.testProvider({ name: "p1", prompt: "x" });

      expectRequest({
        method: "GET",
        path: "/api/llm/logs?page=1&perPage=30",
        reply: { items: [] },
      });
      await client.llm.logs.getList();

      expectRequest({
        method: "GET",
        path: "/api/llm/logs/l1",
        reply: { id: "l1" },
      });
      await client.llm.logs.getOne("l1");

      expectRequest({
        method: "GET",
        path: "/api/llm/logs/stats?interval=day&groupBy=model",
        reply: [],
      });
      await client.llm.logs.getStats({ interval: "day", groupBy: "model" });

      expectRequest({
        method: "GET",
        path: "/api/llm/logs/top-users?by=ip&sort=tokens&limit=5",
        reply: [],
      });
      await client.llm.logs.getTopUsers({ by: "ip", sort: "tokens", limit: 5 });

      expectRequest({ method: "DELETE", path: "/api/llm/logs", replyCode: 204 });
      assert.isTrue(await client.llm.logs.truncate());
    });

    function sseResponse(chunks: Array<string>): Response {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const c of chunks) {
            controller.enqueue(encoder.encode(c));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    test("chatStream() should emit the deltas and resolve with the done event", async function () {
      const deltas: Array<string> = [];
      let sentBody: any = null;

      const result = await client.llm.chatStream(
        "support",
        { messages: [{ role: "user", content: "hi" }] },
        {
          onDelta: (e) => deltas.push(e.text || ""),
          fetch: async (_, config) => {
            sentBody = JSON.parse(config?.body as string);
            return sseResponse([
              'event: delta\ndata: {"type":"text","text":"Hel"}\n\n',
              'event: delta\ndata: {"type":"text",',
              '"text":"lo"}\n\nevent: done\ndata: {"text":"Hello","model":"m"}\n\n',
            ]);
          },
        },
      );

      assert.isTrue(sentBody.stream);
      assert.deepEqual(deltas, ["Hel", "lo"]);
      assert.equal(result.text, "Hello");
    });

    test("chatStream() should reject a mid-stream error event", async function () {
      await expect(
        client.llm.chatStream(
          "support",
          { messages: [] },
          {
            fetch: async () =>
              sseResponse([
                'event: delta\ndata: {"type":"text","text":"x"}\n\n',
                'event: error\ndata: {"message":"provider failed"}\n\n',
              ]),
          },
        ),
      ).rejects.toMatchObject({ status: 502, message: "provider failed" });
    });

    test("chatStream() should reject the regular json errors", async function () {
      await expect(
        client.llm.chatStream(
          "support",
          { messages: [] },
          {
            fetch: async () =>
              new Response(JSON.stringify({ status: 429, message: "quota" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              }),
          },
        ),
      ).rejects.toMatchObject({ status: 429, message: "quota" });
    });
  });

  describe("ApplicationService", function () {
    test("applications, installations and extensions", async function () {
      expectRequest({
        method: "GET",
        path: "/api/applications",
        reply: { items: [] },
      });
      await client.applications.getList();

      expectRequest({
        method: "POST",
        path: "/api/applications",
        body: { handle: "my-app", name: "My app", scopes: ["read_posts"] },
        reply: { created: true },
      });
      await client.applications.create({
        handle: "my-app",
        name: "My app",
        scopes: ["read_posts"],
      });

      const toml = 'handle = "my-app"\nname = "My app"\nversion = "1.0.0"\n';
      expectRequest({
        method: "POST",
        path: "/api/applications/manifests",
        contentType: "application/toml",
        body: toml,
        reply: { created: true },
      });
      await client.applications.importManifest(toml);

      expectRequest({
        method: "POST",
        path: "/api/applications/manifests",
        contentType: "application/json",
        body: { handle: "my-app", name: "My app", version: "1.0.1" },
        reply: { created: false },
      });
      await client.applications.importManifest({
        handle: "my-app",
        name: "My app",
        version: "1.0.1",
      });

      const permissions = { collections: { posts: ["list", "view"] } };

      expectRequest({
        method: "POST",
        path: "/api/applications/a1/install",
        body: { permissions },
        reply: { clientId: "pba_1", clientSecret: "s", notified: false },
      });
      assert.equal((await client.applications.install("a1", permissions)).clientId, "pba_1");

      expectRequest({
        method: "PATCH",
        path: "/api/applications/installations/i1",
        body: { permissions, versionRef: "v2" },
        reply: { id: "i1" },
      });
      await client.applications.update("i1", { permissions, versionRef: "v2" });

      expectRequest({
        method: "POST",
        path: "/api/applications/installations/i1/rotate-secret",
        reply: { clientSecret: "s2" },
      });
      await client.applications.rotateSecret("i1");

      expectRequest({
        method: "POST",
        path: "/api/applications/installations/i1/launch",
        body: { extension: "post-inspect", recordId: "p1" },
        reply: { url: "https://vendor/ext", launchToken: "jwt" },
      });
      assert.equal(
        (await client.applications.launch("i1", "post-inspect", "p1")).launchToken,
        "jwt",
      );

      expectRequest({
        method: "GET",
        path: "/api/applications/extensions",
        reply: [],
      });
      await client.applications.extensions();

      expectRequest({
        method: "DELETE",
        path: "/api/applications/installations/i1",
        replyCode: 204,
      });
      assert.isTrue(await client.applications.uninstall("i1"));

      expectRequest({
        method: "DELETE",
        path: "/api/applications/a1",
        replyCode: 204,
      });
      assert.isTrue(await client.applications.delete("a1"));
    });

    test("catalog", async function () {
      expectRequest({
        method: "GET",
        path: "/api/applications/catalog?refresh=1",
        reply: { items: [], sources: [] },
      });
      await client.applications.catalog.getList({ refresh: true });

      expectRequest({
        method: "GET",
        path: "/api/applications/catalog?q=1",
        reply: { items: [], sources: [] },
      });
      await client.applications.catalog.getList({ query: { q: 1 } });

      expectRequest({
        method: "GET",
        path: "/api/applications/catalog/manifest?source=Org&handle=my-app",
        reply: { scopes: [] },
      });
      await client.applications.catalog.getManifest("Org", "my-app");

      expectRequest({
        method: "POST",
        path: "/api/applications/catalog/install",
        body: { source: "Org", handle: "my-app", permissions: {} },
        reply: { notified: true },
      });
      assert.isTrue((await client.applications.catalog.install("Org", "my-app", {})).notified);

      expectRequest({
        method: "POST",
        path: "/api/applications/catalog/import",
        body: { source: "Org", handle: "my-app" },
        reply: { created: false },
      });
      await client.applications.catalog.import("Org", "my-app");
    });
  });

  describe("SessionService", function () {
    test("active sessions and end", async function () {
      assert.equal(client.sessions.baseCrudPath, "/api/collections/_authSessions/records");

      const filter = encodeURIComponent(
        'collectionRef="c1" && recordRef="r1" && status=\'active\' && expiresAt>@now',
      );
      expectRequest({
        method: "GET",
        path:
          "/api/collections/_authSessions/records?page=1&perPage=1000&skipTotal=1&sort=-lastUsedAt&expand=client&filter=" +
          filter,
        reply: { items: [{ id: "s1" }] },
      });
      assert.equal((await client.sessions.getActiveList("c1", "r1"))[0].id, "s1");

      expectRequest({
        method: "POST",
        path: "/api/sessions/s%2F1/end",
        replyCode: 204,
      });
      assert.isTrue(await client.sessions.end("s/1"));
    });
  });
});
