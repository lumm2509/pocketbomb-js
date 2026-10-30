import { describe, assert, test, beforeAll, inject } from "vitest";
import {
  AsyncAuthStore,
  createAccountClient,
  MemoryLoginSession,
  type AsyncKeyValueStorage,
  type OpenAuthSession,
} from "@pocketbomb/primer";
import { createCustomerAccountClient } from "@pocketbomb/dynamite/customer-account";
import { CookieJar, followHostedFlow, ownerClient, raw } from "./helpers";

const url = inject("pbURL");

// a native app redirect URI (custom scheme; never fetched)
const CLIENT_ID = "int_mobile";
const REDIRECT = "pocketbombshop://auth/callback";
const CUSTOMER = { email: "mobile.customer@example.com", password: "MobilePass12345" };

/** An AsyncStorage-like in-memory storage (the React Native AsyncStorage API subset). */
class MemoryAsyncStorage implements AsyncKeyValueStorage {
  data = new Map<string, string>();
  async getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  async removeItem(key: string) {
    this.data.delete(key);
  }
}

/**
 * An `openAuthSession` adapter that behaves like ASWebAuthenticationSession / Expo
 * `WebBrowser.openAuthSessionAsync`: it follows the hosted pages with its own cookie
 * jar (the in-app browser) until the redirect to the app URI.
 */
function headlessAuthSession(jar: CookieJar, credentials?: { identity: string; password: string }) {
  const opened: Array<string> = [];
  const open: OpenAuthSession = async (authURL, redirectUri) => {
    opened.push(authURL);
    const finalURL = await followHostedFlow(authURL, redirectUri, credentials, jar);
    return { type: "success", url: finalURL };
  };
  return { open, opened };
}

describe("mobile-like flow (AsyncStorage adapter + openAuthSession, real server)", function () {
  beforeAll(async function () {
    const owner = await ownerClient(url);
    await owner.settings.update({ meta: { appURL: url } });

    const users = await owner.collections.getOne("users");
    await owner.collection("users").create({
      email: CUSTOMER.email,
      password: CUSTOMER.password,
      passwordConfirm: CUSTOMER.password,
      verified: true,
    });

    await owner.oauth2Clients.create({
      name: "Integration mobile",
      clientId: CLIENT_ID,
      type: "public",
      collectionRef: users.id,
      redirectURIs: [REDIRECT],
      postLogoutRedirectURIs: [REDIRECT],
      scopes: ["openid", "email", "offline_access"],
      firstParty: true,
    });
  });

  test("login, app restart (restore + refresh rotation), logout", async function () {
    const storage = new MemoryAsyncStorage();
    const jar = new CookieJar();
    const session = headlessAuthSession(jar, {
      identity: CUSTOMER.email,
      password: CUSTOMER.password,
    });

    // app start #1
    const authStore = AsyncAuthStore.fromStorage(storage, "shop_auth");
    await authStore.ready;
    const customer = createCustomerAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      scopes: ["openid", "email", "offline_access"],
      authStore,
      session: new MemoryLoginSession(),
      openAuthSession: session.open,
    });

    const result = await customer.login({ state: { screen: "cart" } });
    assert.deepEqual(result?.state, { screen: "cart" });
    assert.equal(result?.record?.email, CUSTOMER.email);
    assert.isTrue(customer.isLoggedIn());
    assert.lengthOf(session.opened, 1);
    await authStore.flush();
    assert.include(storage.data.get("shop_auth") || "", authStore.refreshToken);

    // app start #2: the persisted session is restored; an expired access token is refreshed
    const restoredStore = AsyncAuthStore.fromStorage(storage, "shop_auth");
    await restoredStore.ready;
    assert.equal(restoredStore.token, authStore.token);
    const firstRefreshToken = restoredStore.refreshToken;
    restoredStore.save(restoredStore.token, restoredStore.record, {
      ...restoredStore.meta,
      expiresAt: 1,
    });

    const restarted = createAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: restoredStore,
      openAuthSession: session.open,
    });
    assert.isTrue(await restarted.account.restore());
    assert.notEqual(restoredStore.refreshToken, firstRefreshToken, "the refresh token is rotated");
    assert.equal((await restarted.account.me()).record?.email, CUSTOMER.email);
    await restoredStore.flush();
    assert.include(storage.data.get("shop_auth") || "", restoredStore.refreshToken);

    // the rotated-out refresh token is rejected
    const reuse = await raw(url + "/oauth2/users/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: firstRefreshToken,
      }).toString(),
    });
    assert.equal(reuse.status, 400);

    // logout: revoke + end_session in the auth session + the storage is cleared
    const accessToken = restoredStore.token;
    const logoutURL = await restarted.account.logout();
    assert.lengthOf(session.opened, 2);
    assert.equal(session.opened[1], logoutURL);
    await restoredStore.flush();
    assert.isFalse(storage.data.has("shop_auth"));

    const me = await raw(url + "/api/permissions/me", { headers: { Authorization: accessToken } });
    assert.equal(me.status, 401);

    // the in-app browser SSO session ended: the next authorize request shows the login form
    const again = createAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: AsyncAuthStore.fromStorage(storage, "shop_auth"),
    });
    const silent = await fetch(await again.account.authorizeURL(), {
      redirect: "manual",
      headers: { cookie: jar.header() },
    });
    assert.include(silent.headers.get("location") || "", "/oauth2/users/login?");
  });

  test("a cancelled auth session leaves the app signed out", async function () {
    const customer = createCustomerAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: AsyncAuthStore.fromStorage(new MemoryAsyncStorage()),
      openAuthSession: async () => ({ type: "cancel" }),
    });

    assert.isNull(await customer.login());
    assert.isFalse(customer.isLoggedIn());
  });
});
