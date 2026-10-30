import { describe, assert, expect, test, beforeAll, inject } from "vitest";
import {
  AuthStore,
  Client,
  CookieAuthStore,
  createAccountClient,
  createPublicClient,
} from "pocketbomb-primer";
import type { DashboardClient } from "pocketbomb-primer/internal";
import { CookieJar, followHostedFlow, loginAccountClient, ownerClient, raw } from "./helpers";

const url = inject("pbURL");

// the GraphQL ids are the Relay global ids: base64url("{collectionName}:{id}")
function recordId(globalId: string): string {
  const decoded = Buffer.from(globalId, "base64url").toString("utf8");
  assert.isTrue(decoded.startsWith("articles:"), decoded);
  return decoded.substring("articles:".length);
}

const CUSTOMER = { email: "customer@example.com", password: "CustomerPass123" };
const CLIENT_ID = "int_storefront";
const REDIRECT = url + "/callback";

describe("storefront + account (real server)", function () {
  let owner: DashboardClient;
  let articlesId = "";
  let clientRecordId = "";
  let publicKey = "";
  let privateKey = "";
  let articleIds: Array<string> = [];

  beforeAll(async function () {
    owner = await ownerClient(url);

    // the issuer identifier (iss) is based on the app URL
    await owner.settings.update({ meta: { appURL: url } });

    const articles = await owner.collections.create({
      name: "articles",
      type: "base",
      fields: [
        { name: "title", type: "text" },
        { name: "handle", type: "text" },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_articles_handle ON articles (handle)"],
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
    });
    articlesId = articles.id;

    await owner.collections.create({
      name: "int_notes",
      type: "base",
      fields: [{ name: "title", type: "text" }],
      listRule: "",
      viewRule: "",
    });

    articleIds = [];
    for (let i = 1; i <= 3; i++) {
      const a = await owner.collection("articles").create({
        title: "Article " + i,
        handle: "article-" + i,
      });
      articleIds.push(a.id);
    }
    await owner.collection("int_notes").create({ title: "note" });

    const users = await owner.collections.getOne("users");

    await owner.collection("users").create({
      email: CUSTOMER.email,
      password: CUSTOMER.password,
      passwordConfirm: CUSTOMER.password,
      verified: true,
    });

    const storefront = await owner.oauth2Clients.create({
      name: "Integration storefront",
      clientId: CLIENT_ID,
      type: "public",
      collectionRef: users.id,
      redirectURIs: [REDIRECT],
      postLogoutRedirectURIs: [REDIRECT],
      scopes: ["openid", "email", "profile", "offline_access"],
      firstParty: true,
    });
    clientRecordId = storefront.id;

    const keys = owner.oauth2Clients.apiKeys(clientRecordId);

    publicKey = (
      await keys.create({
        name: "public",
        kind: "public",
        permissions: { collections: { [articlesId]: ["list", "view"] } },
      })
    ).token;

    privateKey = (
      await keys.create({
        name: "private",
        kind: "private",
        buyerContext: "required",
        permissions: {
          collections: { [articlesId]: ["list", "view", "create"] },
        },
      })
    ).token;
  });

  test("deny by default: no API key and no token -> 401", async function () {
    const anonymous = new Client(url);

    await expect(anonymous.collection("articles").getList()).rejects.toMatchObject({
      status: 401,
    });
  });

  test("public key: REST and GraphQL return the same records", async function () {
    assert.isTrue(publicKey.startsWith("pb_pk_"));

    const pb = createPublicClient({ url, publicKey });

    const rest = await pb.collection("articles").getFullList({ sort: "handle" });
    assert.deepEqual(
      rest.map((r) => r.id),
      articleIds,
    );

    const gql = await pb.graphql<any>(
      `query Articles($first: Int) {
                articles(first: $first, sort: "handle") {
                    nodes { id title handle }
                    pageInfo { hasNextPage endCursor }
                    totalCount
                }
            }`,
      { variables: { first: 2 } },
    );

    assert.isUndefined(gql.errors);
    assert.equal(gql.data.articles.totalCount, 3);
    assert.isTrue(gql.data.articles.pageInfo.hasNextPage);

    const next = await pb.graphql<any>(
      `query Next($after: String) {
                articles(first: 2, after: $after, sort: "handle") { nodes { id title handle } }
            }`,
      { variables: { after: gql.data.articles.pageInfo.endCursor } },
    );

    const gqlNodes = [...gql.data.articles.nodes, ...next.data.articles.nodes].map((n: any) =>
      Object.assign({}, n, { id: recordId(n.id) }),
    );
    assert.deepEqual(
      gqlNodes,
      rest.map((r) => ({ id: r.id, title: r.title, handle: r.handle })),
    );

    // unique field lookup (view rule path) == REST view
    const single = await pb.graphql<any>(`{ article(handle: "article-2") { id title } }`);
    const view = await pb.collection("articles").getOne(articleIds[1]);
    assert.deepEqual(
      { id: recordId(single.data.article.id), title: single.data.article.title },
      { id: view.id, title: view.title },
    );

    // the key ceiling: other collections and writes are denied
    await expect(pb.collection("int_notes").getList()).rejects.toMatchObject({
      status: 403,
    });
    await expect(pb.collection("articles").create({ title: "x" })).rejects.toMatchObject({
      status: 403,
    });
  });

  test("private key requires the buyer IP", async function () {
    assert.isTrue(privateKey.startsWith("pb_sk_"));

    const pb = createPublicClient({ url, privateKey, buyerIp: "203.0.113.7" });

    const list = await pb.collection("articles").getList(1, 10);
    assert.equal(list.totalItems, 3);

    const created = await pb.collection("articles").create({
      title: "From the server",
      handle: "server-1",
    });
    assert.equal(created.title, "From the server");
    await owner.collection("articles").delete(created.id);

    // the factory guard
    assert.throws(() => createPublicClient({ url, privateKey }), /buyerIp/);

    // the server check (a low-level client without the buyer IP)
    const noBuyer = new Client(url);
    noBuyer.privateKey = privateKey;
    await expect(noBuyer.collection("articles").getList()).rejects.toMatchObject({
      status: 401,
    });
  });

  test("account: hosted login, record, userinfo, consents, key + token", async function () {
    const { pb } = await loginAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      identity: CUSTOMER.email,
      password: CUSTOMER.password,
      publicKey,
    });

    assert.isTrue(pb.account.isLoggedIn());
    assert.equal(pb.authStore.record?.email, CUSTOMER.email);
    assert.equal(pb.authStore.record?.collectionName, "users");
    assert.isNotEmpty(pb.authStore.refreshToken);
    assert.isNotEmpty(pb.authStore.idToken);
    assert.equal(pb.authStore.clientId, CLIENT_ID);

    const me = await pb.account.me();
    assert.equal(me.kind, "customer");

    const info = await pb.account.userinfo();
    assert.equal(info.sub, pb.authStore.record?.id);
    assert.equal(info.email, CUSTOMER.email);

    // token + key of the same client (the key ceiling still applies)
    const list = await pb.collection("articles").getList();
    assert.equal(list.totalItems, 3);
    await expect(pb.collection("int_notes").getList()).rejects.toMatchObject({
      status: 403,
    });

    // first-party consents (none are remembered for first-party clients)
    assert.isArray(await pb.account.consents.list());
  });

  test("account: refresh rotation serialized across clients sharing the store (lock)", async function () {
    const store = new AuthStore();
    const lockName = "int_refresh_lock";

    const { pb: tab1 } = await loginAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      identity: CUSTOMER.email,
      password: CUSTOMER.password,
      authStore: store,
      lockName,
    });

    // a second "tab" sharing the same stored state and lock
    const tab2 = createAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: store,
      lockName,
    });

    let tokenRequests = 0;
    for (const pb of [tab1, tab2]) {
      pb.beforeSend = (reqURL, options) => {
        if (reqURL.endsWith("/oauth2/users/token")) {
          tokenRequests++;
        }
        return { url: reqURL, options };
      };
    }

    for (let i = 0; i < 3; i++) {
      const before = store.refreshToken;
      const requests = tokenRequests;

      const results = await Promise.all([tab1.account.refresh(), tab2.account.refresh()]);

      assert.deepEqual(results, [true, true]);
      assert.equal(tokenRequests - requests, 1, "exactly one refresh request");
      assert.notEqual(store.refreshToken, before, "the refresh token is rotated");

      // the rotated-out refresh token is rejected
      const reuse = await raw(url + "/oauth2/users/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: before,
        }).toString(),
      });
      assert.equal(reuse.status, 400);
      assert.equal(reuse.data.error, "invalid_grant");

      // and the session survives (grace window of the concurrent previous token)
      const me = await tab1.account.me();
      assert.equal(me.kind, "customer");
    }
  });

  test("account: logout revokes and ends the issuer session", async function () {
    let navigated = "";

    const { pb, jar } = await loginAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      identity: CUSTOMER.email,
      password: CUSTOMER.password,
      navigate: (u: string) => (navigated = u),
    });

    const accessToken = pb.authStore.token;
    const refreshToken = pb.authStore.refreshToken;

    const logoutURL = await pb.account.logout();

    assert.equal(navigated, logoutURL);
    assert.equal(pb.authStore.token, "");
    assert.include(logoutURL, "id_token_hint=");

    // RP-initiated logout in the "browser" (with the SSO cookies)
    const back = await followHostedFlow(logoutURL, REDIRECT, undefined, jar);
    assert.isTrue(back.startsWith(REDIRECT));

    const me = await raw(url + "/api/permissions/me", {
      headers: { Authorization: accessToken },
    });
    assert.equal(me.status, 401);

    const refreshed = await raw(url + "/oauth2/users/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
    assert.equal(refreshed.status, 400);

    // the next login asks for the credentials again (no silent SSO reuse)
    const next = new URL(await pb.account.authorizeURL());
    assert.equal(next.searchParams.get("prompt"), "login");
  });

  test("SSR: CookieAuthStore as auth store and login flow session", async function () {
    const jar = new CookieJar();

    const ssrClient = (store: CookieAuthStore) =>
      createAccountClient({
        url,
        collection: "users",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        authStore: store,
        session: store,
      });

    const cookieHeader = (setCookies: Array<string>, prev = "") => {
      const map = new Map<string, string>();
      for (const part of prev.split("; ").filter(Boolean)) {
        const i = part.indexOf("=");
        map.set(part.substring(0, i), part.substring(i + 1));
      }
      for (const c of setCookies) {
        const pair = c.split(";")[0];
        const i = pair.indexOf("=");
        map.set(pair.substring(0, i), pair.substring(i + 1));
      }
      return Array.from(map, ([k, v]) => k + "=" + v).join("; ");
    };

    // request 1: /login -> redirect to the issuer (the flow state is in a cookie)
    const store1 = new CookieAuthStore({ request: "" });
    const authorizeURL = await ssrClient(store1).account.authorizeURL();
    let browserCookies = cookieHeader(store1.commit());
    assert.include(browserCookies, "pb_auth_flow=");

    const callbackURL = await followHostedFlow(
      authorizeURL,
      REDIRECT,
      { identity: CUSTOMER.email, password: CUSTOMER.password },
      jar,
    );

    // request 2: /callback
    const store2 = new CookieAuthStore({ request: browserCookies });
    const result = await ssrClient(store2).account.handleCallback(callbackURL);
    assert.equal(result?.record?.email, CUSTOMER.email);
    browserCookies = cookieHeader(store2.commit(), browserCookies);
    assert.include(browserCookies, "pb_auth=");

    // request 3: an authenticated page
    const store3 = new CookieAuthStore({ request: browserCookies });
    const pb3 = ssrClient(store3);
    assert.isTrue(pb3.account.isLoggedIn());
    assert.equal((await pb3.account.me()).record?.email, CUSTOMER.email);
    assert.isEmpty(store3.commit(), "nothing changed");
  });
});
