import { AuthStore, MemoryLoginSession } from "@pocketbomb/primer";
import { assert, describe, expect, test } from "vitest";
import { createRequestContext } from "../core/request-context";
import { gql } from "../graphql/graphql";
import { dummyJWT, form, mockFetch, type RecordedRequest } from "../test-utils";
import { createCustomerAccountClient, isSafeReturnTo } from "./customer-account";

const url = "http://pb.local";
const app = "http://shop.local";
const exp = () => Math.floor(Date.now() / 1000) + 3600;

const base = {
  url,
  collection: "users",
  clientId: "shop",
  redirectUri: app + "/account/callback",
};

/** A fake issuer: the token endpoint (code + refresh) and permissions/me. */
function issuer(state: { verifier?: string; nonce?: string } = {}) {
  const accessToken = dummyJWT({ exp: exp(), sid: "s1" });

  const mock = mockFetch(
    (req: RecordedRequest) => {
      if (req.url !== url + "/oauth2/users/token") return undefined;
      const f = form(req.body);
      if (
        f.get("grant_type") === "authorization_code" &&
        f.get("code_verifier") === state.verifier
      ) {
        return {
          body: {
            access_token: accessToken,
            refresh_token: "rt1",
            id_token: dummyJWT({ nonce: state.nonce }),
            expires_in: 3600,
          },
        };
      }
      return { status: 400, body: { error: "invalid_grant" } };
    },
    (req) =>
      req.url === url + "/api/permissions/me"
        ? {
            body: {
              kind: "customer",
              record: { id: "u1", collectionName: "users", email: "c@x.y" },
            },
          }
        : undefined,
    (req) => (req.url === url + "/oauth2/users/revoke" ? { body: {} } : undefined),
    (req) => (req.url === url + "/oauth2/users/userinfo" ? { body: { sub: "u1" } } : undefined),
    (req) =>
      req.url === url + "/api/graphql" ? { body: { data: { me: { id: "u1" } } } } : undefined,
    (req) =>
      req.url.startsWith(url + "/api/collections/users/request-")
        ? { status: 204, body: null }
        : undefined,
  );

  return { ...mock, accessToken };
}

function cookieHeader(setCookies: Array<string>): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function flowFromCookie(setCookie: string): any {
  const value = decodeURIComponent(setCookie.split(";")[0].split("=").slice(1).join("="));
  const data = JSON.parse(value);
  return Object.values(data).find((v: any) => v?.verifier);
}

describe("createCustomerAccountClient() SSR", function () {
  test("loginRedirect() -> callbackRedirect() -> authenticated request -> logoutRedirect()", async function () {
    const state: { verifier?: string; nonce?: string } = {};
    const mock = issuer(state);

    // request 1: /account/login
    const ctx1 = createRequestContext({ request: new Request(app + "/account/login") });
    const account1 = createCustomerAccountClient({
      ...base,
      requestContext: ctx1,
      fetch: mock.fetch,
    });

    const login = await account1.loginRedirect({ returnTo: "/orders" });
    assert.equal(login.status, 302);
    const authorize = new URL(login.headers.get("location")!);
    assert.equal(authorize.origin + authorize.pathname, url + "/oauth2/users/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), base.redirectUri);
    assert.equal(
      login.headers.get("cache-control"),
      "private, no-store, max-age=0, must-revalidate",
    );

    const flowCookie = login.headers.getSetCookie().find((c) => c.startsWith("pb_auth_flow="))!;
    assert.include(flowCookie, "HttpOnly");
    const flow = flowFromCookie(flowCookie);
    state.verifier = flow.verifier;
    state.nonce = flow.nonce;

    // request 2: /account/callback (with the flow cookie)
    const callbackURL = base.redirectUri + "?code=c1&state=" + authorize.searchParams.get("state");
    const ctx2 = createRequestContext({
      request: new Request(callbackURL, { headers: { cookie: cookieHeader([flowCookie]) } }),
    });
    const account2 = createCustomerAccountClient({
      ...base,
      requestContext: ctx2,
      fetch: mock.fetch,
    });
    const callback = await account2.callbackRedirect();
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/orders");

    const cookies = callback.headers.getSetCookie();
    const authCookie = cookies.find((c) => c.startsWith("pb_auth="))!;
    assert.include(authCookie, "HttpOnly");
    assert.isTrue(
      cookies.some((c) => c.startsWith("pb_auth_flow=;") || /pb_auth_flow=;.*Max-Age=0/i.test(c)),
      "the flow cookie is cleared",
    );

    // request 3: an authenticated page
    const ctx3 = createRequestContext({
      request: new Request(app + "/orders", { headers: { cookie: cookieHeader([authCookie]) } }),
    });
    const account3 = createCustomerAccountClient({
      ...base,
      requestContext: ctx3,
      fetch: mock.fetch,
    });
    assert.isTrue(account3.isLoggedIn());
    assert.equal((await account3.me()).record?.id, "u1");
    assert.equal(await account3.getAccessToken(), mock.accessToken);
    const page = new Headers();
    ctx3.applyResponseHeaders(page);
    assert.equal(page.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
    assert.isNull(page.get("set-cookie"), "nothing changed");

    // request 4: /account/logout
    const ctx4 = createRequestContext({
      request: new Request(app + "/account/logout", {
        headers: { cookie: cookieHeader([authCookie]) },
      }),
    });
    const account4 = createCustomerAccountClient({
      ...base,
      requestContext: ctx4,
      fetch: mock.fetch,
    });
    const logout = await account4.logoutRedirect();
    const end = new URL(logout.headers.get("location")!);
    assert.equal(end.origin + end.pathname, url + "/oauth2/users/logout");
    assert.isTrue(mock.requests.some((r) => r.url === url + "/oauth2/users/revoke"));
    assert.isTrue(
      logout.headers.getSetCookie().some((c) => c.startsWith("pb_auth=") && /Max-Age=0/i.test(c)),
      "the session cookie is cleared",
    );
  });

  test("callbackRedirect() ignores an unsafe returnTo and supports successRedirect", async function () {
    const state: { verifier?: string; nonce?: string } = {};
    const mock = issuer(state);
    const ctx1 = createRequestContext({ request: new Request(app + "/login") });
    const login = await createCustomerAccountClient({
      ...base,
      requestContext: ctx1,
      fetch: mock.fetch,
    }).loginRedirect({ returnTo: "//evil.example/x" });
    const flowCookie = login.headers.getSetCookie().find((c) => c.startsWith("pb_auth_flow="))!;
    Object.assign(state, flowFromCookie(flowCookie));

    const authorize = new URL(login.headers.get("location")!);
    const ctx2 = createRequestContext({
      request: new Request(app + "/whatever", { headers: { cookie: cookieHeader([flowCookie]) } }),
    });
    const callback = await createCustomerAccountClient({
      ...base,
      requestContext: ctx2,
      fetch: mock.fetch,
    }).callbackRedirect({
      url: base.redirectUri + "?code=c&state=" + authorize.searchParams.get("state"),
      successRedirect: "/account",
    });
    assert.equal(callback.headers.get("location"), "/account");
  });

  test("callbackRedirect() rejects an error response and the redirect helpers require a request context", async function () {
    const ctx = createRequestContext({
      request: new Request(base.redirectUri + "?error=access_denied&state=x"),
    });
    const account = createCustomerAccountClient({
      ...base,
      requestContext: ctx,
      fetch: issuer().fetch,
    });
    await expect(account.callbackRedirect()).rejects.toMatchObject({
      oauth2Error: "access_denied",
    });

    const noRequestURL = createCustomerAccountClient({
      ...base,
      requestContext: createRequestContext({ request: { headers: new Headers() } }),
    });
    await expect(noRequestURL.callbackRedirect()).rejects.toThrow(/request.url/);

    const browser = createCustomerAccountClient({ ...base, authStore: new AuthStore() });
    await expect(browser.loginRedirect()).rejects.toThrow(/requestContext/);
    await expect(browser.callbackRedirect()).rejects.toThrow(/requestContext/);
    await expect(browser.logoutRedirect()).rejects.toThrow(/requestContext/);
  });

  test("isSafeReturnTo()", function () {
    assert.isTrue(isSafeReturnTo("/orders?x=1"));
    assert.isFalse(isSafeReturnTo("//evil.example"));
    assert.isFalse(isSafeReturnTo("/\\evil.example"));
    assert.isFalse(isSafeReturnTo("https://evil.example"));
    assert.isFalse(isSafeReturnTo("orders"));
  });
});

describe("createCustomerAccountClient() browser/mobile", function () {
  test("login() with an openAuthSession adapter and the customer APIs", async function () {
    const state: { verifier?: string; nonce?: string } = {};
    const mock = issuer(state);
    const session = new MemoryLoginSession();
    const authStore = new AuthStore();

    const account = createCustomerAccountClient({
      ...base,
      publicKey: "pb_pk_1",
      authStore,
      session,
      fetch: mock.fetch,
      openAuthSession: async (authorizeURL, redirectUri) => {
        const flowKey = "__pb_oauth2_flow__users_shop";
        Object.assign(state, session.get(flowKey));
        return {
          type: "success",
          url: redirectUri + "?code=c1&state=" + new URL(authorizeURL).searchParams.get("state"),
        };
      },
    });

    const result = await account.login({ state: { screen: "cart" } });
    assert.deepEqual(result?.state, { screen: "cart" });
    assert.equal(authStore.token, mock.accessToken);
    assert.isTrue(account.isLoggedIn());
    assert.equal(account.account, account.client.account);

    assert.deepEqual(await account.userinfo(), { sub: "u1" });

    const ME = gql<{ me: { id: string } }>(`{ me { id } }`);
    assert.deepEqual(await account.query(ME), { me: { id: "u1" } });
    assert.deepEqual((await account.graphql(ME)).data, { me: { id: "u1" } });
    const gqlRequest = mock.requests.find((r) => r.url === url + "/api/graphql")!;
    assert.equal(gqlRequest.headers["Authorization"], mock.accessToken);
    assert.equal(gqlRequest.headers["X-PB-Public-Key"], "pb_pk_1");

    assert.isTrue(await account.requestEmailChange("new@x.y"));
    assert.isTrue(await account.requestVerification("c@x.y"));
    assert.deepEqual(
      JSON.parse(mock.requests.find((r) => r.url.endsWith("/request-email-change"))!.body),
      { newEmail: "new@x.y" },
    );

    const signupURLs: Array<string> = [];
    const signup = createCustomerAccountClient({
      ...base,
      authStore: new AuthStore(),
      openAuthSession: async (u) => {
        signupURLs.push(u);
        return { type: "dismiss" };
      },
    });
    assert.isNull(await signup.signup());
    assert.equal(new URL(signupURLs[0]).searchParams.get("prompt"), "create");

    // handleCallback() of a non callback URL
    assert.isNull(await account.handleCallback(app + "/x"));

    // logout without the auth session redirect
    const logoutURL = await account.logout({ redirect: false });
    assert.include(logoutURL, "/oauth2/users/logout?");
    assert.isFalse(account.isLoggedIn());
  });
});
