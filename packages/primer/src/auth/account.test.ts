import { describe, assert, expect, test, beforeAll, afterAll, afterEach } from "vitest";
import { FetchMock, dummyJWT } from "../test-utils/mocks";
import { Client } from "../client";
import { createAccountClient } from "../factories";
import { type LoginSession, MemoryLoginSession, SessionStorageLoginSession } from "./account";
import { AuthStore } from "./store";
import { sha256Base64URL } from "../tools/crypto";

class MapSession implements LoginSession {
  data = new Map<string, any>();
  get(key: string) {
    return this.data.get(key);
  }
  set(key: string, value: any) {
    this.data.set(key, value);
  }
  unset(key: string) {
    this.data.delete(key);
  }
}

const base = "http://test.local";
const tokenURL = base + "/oauth2/users/token";
const meURL = base + "/api/permissions/me";

function form(config: any): URLSearchParams {
  return new URLSearchParams(config?.body || "");
}

function newClient(extra: { openAuthSession?: any } = {}) {
  const session = new MapSession();
  const navigations: Array<string> = [];

  const pb = createAccountClient({
    url: base,
    collection: "users",
    clientId: "my_app",
    redirectUri: base + "/callback",
    session,
    authStore: new AuthStore(),
    navigate: (url) => navigations.push(url),
    lockName: "test_lock_" + Math.random(),
    ...extra,
  });

  return { pb, session, navigations };
}

function flowOf(session: MapSession): any {
  for (const [key, value] of session.data) {
    if (key.startsWith("__pb_oauth2_flow__")) {
      return value;
    }
  }
  return null;
}

describe("Account", function () {
  const fetchMock = new FetchMock();

  beforeAll(function () {
    fetchMock.init();
  });

  afterAll(function () {
    fetchMock.restore();
  });

  afterEach(function () {
    fetchMock.clearMocks();
  });

  const exp = () => Math.floor(Date.now() / 1000) + 3600;

  function mockMe(record: any = { id: "u1", collectionName: "users" }) {
    fetchMock.on({
      method: "GET",
      url: meURL,
      additionalMatcher: (_, config: any) => !!config.headers["Authorization"],
      replyCode: 200,
      replyBody: { kind: "customer", record },
    });
  }

  describe("authorizeURL() / login()", function () {
    test("Should build a PKCE S256 authorization request and store the flow", async function () {
      const { pb, session } = newClient();

      const url = new URL(
        await pb.account.authorizeURL({
          prompt: "consent",
          maxAge: 0,
          loginHint: "a@example.com",
          state: { page: "/x" },
        }),
      );

      assert.equal(url.origin + url.pathname, base + "/oauth2/users/authorize");

      const q = url.searchParams;
      const flow = flowOf(session);

      assert.equal(q.get("client_id"), "my_app");
      assert.equal(q.get("redirect_uri"), base + "/callback");
      assert.equal(q.get("response_type"), "code");
      assert.equal(q.get("scope"), "openid email");
      assert.equal(q.get("code_challenge_method"), "S256");
      assert.equal(q.get("prompt"), "consent");
      assert.equal(q.get("max_age"), "0");
      assert.equal(q.get("login_hint"), "a@example.com");
      assert.equal(q.get("state"), flow.state);
      assert.equal(q.get("nonce"), flow.nonce);
      assert.equal(q.get("code_challenge"), await sha256Base64URL(flow.verifier));
      assert.deepEqual(flow.appState, { page: "/x" });
      assert.equal(flow.verifier.length, 64);
    });

    test("login() should start a single authorize navigation", async function () {
      const { pb, navigations } = newClient();

      await Promise.all([pb.account.login(), pb.account.login()]);

      assert.equal(navigations.length, 1);
      assert.include(navigations[0], "/oauth2/users/authorize?");
    });
  });

  describe("handleCallback()", function () {
    async function startFlow(state?: any) {
      const ctx = newClient();
      await ctx.pb.account.authorizeURL({ state });
      return Object.assign(ctx, { flow: flowOf(ctx.session) });
    }

    test("Should return null for non callback URLs", async function () {
      const { pb } = newClient();

      assert.isNull(await pb.account.handleCallback(base + "/callback?x=1"));
      assert.isFalse(pb.account.isCallbackURL(base + "/callback"));
      assert.isTrue(pb.account.isCallbackURL(base + "/callback?code=1"));
    });

    test("Should exchange the code and store the tokens and record", async function () {
      const { pb, flow, session } = await startFlow({ returnHash: "#/x" });

      const accessToken = dummyJWT({ exp: exp(), type: "auth" });

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        additionalMatcher: (_, config: any) => {
          const f = form(config);
          return (
            config.headers["Content-Type"] === "application/x-www-form-urlencoded" &&
            !config.headers["Authorization"] &&
            f.get("grant_type") === "authorization_code" &&
            f.get("code") === "code123" &&
            f.get("redirect_uri") === base + "/callback" &&
            f.get("code_verifier") === flow.verifier &&
            f.get("client_id") === "my_app"
          );
        },
        replyCode: 200,
        replyBody: {
          access_token: accessToken,
          refresh_token: "rt1",
          id_token: dummyJWT({ nonce: flow.nonce }),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email",
        },
      });
      mockMe();

      const result = await pb.account.handleCallback(
        base + "/callback?code=code123&state=" + flow.state,
      );

      assert.deepEqual(result?.state, { returnHash: "#/x" });
      assert.equal(result?.record?.id, "u1");
      assert.equal(pb.authStore.token, accessToken);
      assert.equal(pb.authStore.refreshToken, "rt1");
      assert.equal(pb.authStore.scope, "openid email");
      assert.equal(pb.authStore.clientId, "my_app");
      assert.isTrue(pb.account.isLoggedIn());

      // the flow is single use
      assert.isNull(flowOf(session));
    });

    test("Should reject an authorization error response", async function () {
      const { pb, flow, session } = await startFlow();

      await expect(
        pb.account.handleCallback(
          base + "/callback?error=access_denied&error_description=Denied&state=" + flow.state,
        ),
      ).rejects.toMatchObject({ oauth2Error: "access_denied", message: "Denied" });

      assert.isNull(flowOf(session));
    });

    test("Should reject a mismatched state", async function () {
      const { pb } = await startFlow();

      await expect(
        pb.account.handleCallback(base + "/callback?code=1&state=other"),
      ).rejects.toMatchObject({ oauth2Error: "invalid_state" });
    });

    test("Should reject a mismatched id_token nonce", async function () {
      const { pb, flow } = await startFlow();

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        replyCode: 200,
        replyBody: {
          access_token: dummyJWT({ exp: exp() }),
          id_token: dummyJWT({ nonce: "other" }),
        },
      });

      await expect(
        pb.account.handleCallback(base + "/callback?code=1&state=" + flow.state),
      ).rejects.toMatchObject({ oauth2Error: "invalid_nonce" });

      assert.equal(pb.authStore.token, "");
    });

    test("Should reject a record of another collection", async function () {
      const { pb, flow } = await startFlow();

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        replyCode: 200,
        replyBody: {
          access_token: dummyJWT({ exp: exp() }),
          id_token: dummyJWT({ nonce: flow.nonce }),
        },
      });
      mockMe({ id: "s1", collectionName: "_superusers" });

      await expect(
        pb.account.handleCallback(base + "/callback?code=1&state=" + flow.state),
      ).rejects.toMatchObject({ oauth2Error: "invalid_record" });
    });
  });

  describe("refresh()", function () {
    test("Should return false without a refresh token (no request)", async function () {
      const { pb } = newClient();

      assert.isFalse(await pb.account.refresh());
    });

    test("Should rotate the tokens with a single request for concurrent calls", async function () {
      const { pb } = newClient();
      pb.authStore.save(dummyJWT({ exp: exp() }), { id: "u1" } as any, {
        refreshToken: "rt1",
        idToken: "it1",
      });

      const newToken = dummyJWT({ exp: exp() + 10 });
      let requests = 0;

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        additionalMatcher: (_, config: any) => {
          const f = form(config);
          const match =
            f.get("grant_type") === "refresh_token" &&
            f.get("refresh_token") === "rt1" &&
            f.get("client_id") === "my_app";
          if (match) {
            requests++;
          }
          return match;
        },
        replyCode: 200,
        replyBody: {
          access_token: newToken,
          refresh_token: "rt2",
          expires_in: 3600,
        },
      });
      mockMe();

      const results = await Promise.all([pb.account.refresh(), pb.account.refresh()]);

      assert.deepEqual(results, [true, true]);
      assert.equal(requests, 1);
      assert.equal(pb.authStore.token, newToken);
      assert.equal(pb.authStore.refreshToken, "rt2");
      // the id_token is kept when not returned
      assert.equal(pb.authStore.idToken, "it1");
    });

    test("Should drop an invalid refresh token", async function () {
      const { pb } = newClient();
      const token = dummyJWT({ exp: exp() });
      pb.authStore.save(token, null, { refreshToken: "rt_bad", idToken: "it1" });

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        replyCode: 400,
        replyBody: { error: "invalid_grant", error_description: "Reused" },
      });

      assert.isFalse(await pb.account.refresh());
      assert.equal(pb.authStore.refreshToken, "");
      assert.equal(pb.authStore.idToken, "");
      assert.equal(pb.authStore.token, token);
    });

    test("Should be used as the client auth strategy (auto refresh before expiry)", async function () {
      const { pb } = newClient();
      pb.authStore.save(dummyJWT({ exp: Math.floor(Date.now() / 1000) + 5 }), null, {
        refreshToken: "rt1",
      });

      const newToken = dummyJWT({ exp: exp() });

      fetchMock.on({
        method: "POST",
        url: tokenURL,
        replyCode: 200,
        replyBody: {
          access_token: newToken,
          refresh_token: "rt2",
          expires_in: 3600,
        },
      });
      mockMe();
      fetchMock.on({
        method: "GET",
        url: base + "/api/collections/posts/records/p1",
        additionalMatcher: (_, config: any) => config.headers["Authorization"] === newToken,
        replyCode: 200,
        replyBody: { id: "p1" },
      });

      const record = await pb.collection("posts").getOne("p1");

      assert.equal(record.id, "p1");
      assert.equal(pb.authStore.refreshToken, "rt2");
    });
  });

  describe("logout()", function () {
    test("Should revoke, clear and navigate to the end_session endpoint", async function () {
      const { pb, navigations } = newClient();
      pb.authStore.save(dummyJWT({ exp: exp() }), { id: "u1" } as any, {
        refreshToken: "rt1",
        idToken: "it1",
      });

      let revoked = false;
      fetchMock.on({
        method: "POST",
        url: base + "/oauth2/users/revoke",
        additionalMatcher: (_, config: any) => {
          const f = form(config);
          revoked =
            f.get("token") === "rt1" &&
            f.get("token_type_hint") === "refresh_token" &&
            f.get("client_id") === "my_app";
          return revoked;
        },
        replyCode: 200,
      });

      const url = await pb.account.logout();

      assert.isTrue(revoked);
      assert.equal(pb.authStore.token, "");
      assert.isTrue(pb.account.isLoggingOut());
      assert.deepEqual(navigations, [url]);

      const q = new URL(url).searchParams;
      assert.equal(q.get("client_id"), "my_app");
      assert.equal(q.get("id_token_hint"), "it1");
      assert.equal(q.get("post_logout_redirect_uri"), base + "/callback");

      // logout guard
      assert.isFalse(await pb.account.refresh());
      await pb.account.login();
      assert.equal(navigations.length, 1);
    });

    test("Should force prompt=login for the next login", async function () {
      const { pb } = newClient();

      await pb.account.logout({ redirect: false });
      assert.isFalse(pb.account.isLoggingOut());

      const first = new URL(await pb.account.authorizeURL());
      assert.equal(first.searchParams.get("prompt"), "login");

      const second = new URL(await pb.account.authorizeURL());
      assert.isNull(second.searchParams.get("prompt"));
    });
  });

  describe("other", function () {
    test("userinfo()", async function () {
      const { pb } = newClient();
      const token = dummyJWT({ exp: exp() });
      pb.authStore.save(token);

      fetchMock.on({
        method: "GET",
        url: base + "/oauth2/users/userinfo",
        additionalMatcher: (_, config: any) => config.headers["Authorization"] === token,
        replyCode: 200,
        replyBody: { sub: "u1" },
      });

      assert.deepEqual(await pb.account.userinfo(), { sub: "u1" });
    });

    test("hosted pages URLs", function () {
      const { pb } = newClient();

      assert.equal(pb.account.passwordResetURL(), base + "/oauth2/users/password-reset");
      assert.equal(pb.account.verifyEmailURL(), base + "/oauth2/users/verify-email/request");
    });

    test("consents", async function () {
      const { pb } = newClient();
      pb.authStore.save(dummyJWT({ exp: exp() }));

      fetchMock.on({
        method: "GET",
        url:
          base +
          "/api/collections/_oauth2Consents/records?page=1&perPage=1000&skipTotal=1&sort=-updated",
        replyCode: 200,
        replyBody: { items: [{ id: "c1" }] },
      });
      fetchMock.on({
        method: "DELETE",
        url: base + "/api/collections/_oauth2Consents/records/c1",
        replyCode: 204,
      });

      const items = await pb.account.consents.list();
      assert.equal(items[0].id, "c1");
      assert.isTrue(await pb.account.consents.revoke("c1"));
    });

    test("Should require the collection, clientId and redirectUri", function () {
      assert.throws(
        () =>
          createAccountClient({
            url: base,
            collection: "",
            clientId: "x",
            redirectUri: "y",
          }),
        /required/,
      );
      assert.instanceOf(newClient().pb, Client);
    });
  });

  describe("signupURL() / signup()", function () {
    test("Should build a prompt=create PKCE authorization request", async function () {
      const { pb, session, navigations } = newClient();

      const url = new URL(await pb.account.signupURL({ loginHint: "new@example.com" }));
      const flow = flowOf(session);

      assert.equal(url.pathname, "/oauth2/users/authorize");
      assert.equal(url.searchParams.get("prompt"), "create");
      assert.equal(url.searchParams.get("login_hint"), "new@example.com");
      assert.equal(url.searchParams.get("state"), flow.state);
      assert.equal(url.searchParams.get("code_challenge"), await sha256Base64URL(flow.verifier));

      await pb.account.signup();
      assert.equal(navigations.length, 1);
      assert.equal(new URL(navigations[0]).searchParams.get("prompt"), "create");
    });
  });

  describe("sessions", function () {
    const sessionsURL = base + "/api/collections/users/sessions";

    test("list()", async function () {
      const { pb } = newClient();
      const token = dummyJWT({ exp: exp(), sid: "s1" });
      pb.authStore.save(token);

      fetchMock.on({
        method: "GET",
        url: sessionsURL,
        additionalMatcher: (_, config: any) => config.headers["Authorization"] === token,
        replyCode: 200,
        replyBody: [
          { id: "s1", current: true },
          { id: "s2", current: false },
        ],
      });

      const items = await pb.account.sessions.list();
      assert.deepEqual(
        items.map((i) => i.id),
        ["s1", "s2"],
      );
    });

    test("end() of another session keeps the local state", async function () {
      const { pb } = newClient();
      const token = dummyJWT({ exp: exp(), sid: "s1" });
      pb.authStore.save(token, null, { refreshToken: "rt1" });

      fetchMock.on({
        method: "POST",
        url: sessionsURL + "/s2/end",
        replyCode: 204,
      });

      assert.isTrue(await pb.account.sessions.end({ id: "s2", current: false }));
      assert.equal(pb.authStore.token, token);
    });

    test("end() of the current session clears the local state", async function () {
      const { pb } = newClient();
      pb.authStore.save(dummyJWT({ exp: exp(), sid: "s1" }), null, {
        refreshToken: "rt1",
      });

      fetchMock.on({
        method: "POST",
        url: sessionsURL + "/s1/end",
        replyCode: 204,
      });

      // by the token session id
      await pb.account.sessions.end("s1");
      assert.equal(pb.authStore.token, "");

      // by the current flag (e.g. the root SSO session)
      pb.authStore.save(dummyJWT({ exp: exp(), sid: "s3" }));
      fetchMock.on({
        method: "POST",
        url: sessionsURL + "/root/end",
        replyCode: 204,
      });
      await pb.account.sessions.end({ id: "root", current: true });
      assert.equal(pb.authStore.token, "");
    });

    test("end() errors are thrown (e.g. another record session -> 404)", async function () {
      const { pb } = newClient();
      const token = dummyJWT({ exp: exp(), sid: "s1" });
      pb.authStore.save(token);

      fetchMock.on({
        method: "POST",
        url: sessionsURL + "/other/end",
        replyCode: 404,
        replyBody: { status: 404, message: "Not found." },
      });

      await expect(pb.account.sessions.end("other")).rejects.toMatchObject({
        status: 404,
      });
      assert.equal(pb.authStore.token, token);
    });
  });

  describe("openAuthSession (mobile)", function () {
    function mockCodeExchange(getFlow: () => any, accessToken: string) {
      fetchMock.on({
        method: "POST",
        url: tokenURL,
        additionalMatcher: (_, config: any) => {
          const f = form(config);
          return (
            f.get("grant_type") === "authorization_code" &&
            f.get("code_verifier") === getFlow()?.verifier
          );
        },
        replyCode: 200,
        replyBody: () => ({
          access_token: accessToken,
          refresh_token: "rt1",
          id_token: dummyJWT({ nonce: getFlow()?.nonce }),
          expires_in: 3600,
        }),
      });
    }

    test("login() opens the auth session and completes the code exchange", async function () {
      let flow: any = null;
      const opened: Array<[string, string]> = [];
      const { pb, session, navigations } = newClient({
        openAuthSession: async (url: string, redirectUri: string) => {
          opened.push([url, redirectUri]);
          flow = flowOf(session);
          return {
            type: "success",
            url: redirectUri + "?code=c1&state=" + new URL(url).searchParams.get("state"),
          };
        },
      });

      const accessToken = dummyJWT({ exp: exp() });
      mockCodeExchange(() => flow, accessToken);
      mockMe();

      const result = await pb.account.login({ state: { screen: "home" } });

      assert.equal(opened.length, 1);
      assert.isTrue(opened[0][0].startsWith(base + "/oauth2/users/authorize?"));
      assert.equal(opened[0][1], base + "/callback");
      assert.deepEqual(navigations, [], "no browser navigation");
      assert.deepEqual(result?.state, { screen: "home" });
      assert.equal(result?.record?.id, "u1");
      assert.equal(pb.authStore.token, accessToken);
      assert.isNull(flowOf(session), "the flow is consumed");

      // a new login can be started afterwards
      const again = await pb.account.signup();
      assert.equal(opened.length, 2);
      assert.equal(new URL(opened[1][0]).searchParams.get("prompt"), "create");
      assert.isNotNull(again);
    });

    test("login() resolves with null and clears the flow when the session is cancelled", async function () {
      const { pb, session } = newClient({
        openAuthSession: async () => ({ type: "cancel" }),
      });

      assert.isNull(await pb.account.login());
      assert.isNull(flowOf(session));
      assert.equal(pb.authStore.token, "");
    });

    test("login() rejects an authorization error redirect", async function () {
      const { pb } = newClient({
        openAuthSession: async (url: string, redirectUri: string) => ({
          type: "success",
          url: redirectUri + "?error=access_denied&state=" + new URL(url).searchParams.get("state"),
        }),
      });

      await expect(pb.account.login()).rejects.toMatchObject({
        oauth2Error: "access_denied",
      });

      // the guard is released after a failure
      await expect(pb.account.login()).rejects.toMatchObject({
        oauth2Error: "access_denied",
      });
    });

    test("logout() opens the end_session page with the auth session", async function () {
      const opened: Array<[string, string]> = [];
      const { pb, navigations } = newClient({
        openAuthSession: async (url: string, redirectUri: string) => {
          opened.push([url, redirectUri]);
          return { type: "success", url: redirectUri };
        },
      });
      pb.authStore.save(dummyJWT({ exp: exp() }), { id: "u1" } as any, { idToken: "it1" });

      const url = await pb.account.logout();

      assert.deepEqual(opened, [[url, base + "/callback"]]);
      assert.deepEqual(navigations, []);
      assert.equal(pb.authStore.token, "");
      assert.isFalse(pb.account.isLoggingOut(), "the logout is completed");
    });
  });

  describe("me()", function () {
    test("Should return the current actor permissions", async function () {
      const { pb } = newClient();
      pb.authStore.save(dummyJWT({ exp: exp() }), null);
      mockMe({ id: "u9", collectionName: "users" });

      const me = await pb.account.me();
      assert.equal(me.kind, "customer");
      assert.equal(me.record?.id, "u9");
    });
  });

  describe("login sessions", function () {
    test("MemoryLoginSession", function () {
      const session = new MemoryLoginSession();
      assert.isUndefined(session.get("a"));
      session.set("a", { b: 1 });
      assert.deepEqual(session.get("a"), { b: 1 });
      session.unset("a");
      assert.isUndefined(session.get("a"));
    });

    test("SessionStorageLoginSession with and without window.sessionStorage", function () {
      const memory = new SessionStorageLoginSession();
      memory.set("a", 1);
      assert.equal(memory.get("a"), 1);
      memory.unset("a");
      assert.isUndefined(memory.get("a"));

      const data = new Map<string, string>();
      (globalThis as any).window = {
        sessionStorage: {
          getItem: (k: string) => data.get(k) ?? null,
          setItem: (k: string, v: string) => data.set(k, v),
          removeItem: (k: string) => data.delete(k),
        },
      };
      try {
        const browser = new SessionStorageLoginSession();
        browser.set("x", { y: "z" });
        assert.equal(data.get("x"), JSON.stringify({ y: "z" }));
        assert.deepEqual(browser.get("x"), { y: "z" });
        data.set("bad", "{");
        assert.isUndefined(browser.get("bad"));
        browser.unset("x");
        assert.isFalse(data.has("x"));
      } finally {
        delete (globalThis as any).window;
      }
    });

    test("the default session is in-memory outside of browsers", function () {
      const pb = createAccountClient({
        url: base,
        collection: "users",
        clientId: "c",
        redirectUri: "r",
      });
      assert.instanceOf(pb.account.config.session, MemoryLoginSession);
    });
  });
});
