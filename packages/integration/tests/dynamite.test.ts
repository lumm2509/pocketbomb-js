import { describe, assert, expect, test, beforeAll, inject } from "vitest";
import {
  Cache,
  createRequestContext,
  createStorefrontClient,
  flattenConnection,
  fromGlobalId,
  gql,
  GraphQLError,
  MemoryCache,
  type ResultOf,
} from "@pocketbomb/dynamite";
import { createCustomerAccountClient } from "@pocketbomb/dynamite/customer-account";
import type { DashboardClient } from "@pocketbomb/primer/internal";
import { CookieJar, followHostedFlow, ownerClient, raw } from "./helpers";

const url = inject("pbURL");

const CLIENT_ID = "int_dynamite";
const APP = "http://shop.example.test";
const REDIRECT = APP + "/account/callback";
const CUSTOMER = { email: "dynamite.customer@example.com", password: "DynamitePass123" };

type Product = { id: string; title: string; handle: string };

const PRODUCTS = gql<
  {
    dynProducts: {
      nodes: Array<Product>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount: number;
    };
  },
  { first: number; after?: string | null }
>(
  `query Products($first: Int, $after: String) {
    dynProducts(first: $first, after: $after, sort: "handle") {
      nodes { ...ProductFields }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }`,
  [gql(`fragment ProductFields on DynProduct { id title handle }`)],
);

/** Collects the Set-Cookie values into a browser Cookie header (name -> latest value). */
function browserCookies(prev: string, setCookies: Array<string>): string {
  const map = new Map<string, string>();
  for (const part of prev.split("; ").filter(Boolean)) {
    const i = part.indexOf("=");
    map.set(part.substring(0, i), part.substring(i + 1));
  }
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    const value = pair.substring(i + 1);
    if (!value || /max-age=0/i.test(c)) {
      map.delete(pair.substring(0, i));
    } else {
      map.set(pair.substring(0, i), value);
    }
  }
  return Array.from(map, ([k, v]) => k + "=" + v).join("; ");
}

describe("dynamite (real server)", function () {
  let owner: DashboardClient;
  let productsId = "";
  let productIds: Array<string> = [];
  let publicKey = "";
  let privateKey = "";

  beforeAll(async function () {
    owner = await ownerClient(url);
    await owner.settings.update({ meta: { appURL: url } });

    const products = await owner.collections.create({
      name: "dyn_products",
      type: "base",
      fields: [
        { name: "title", type: "text" },
        { name: "handle", type: "text" },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_dyn_products_handle ON dyn_products (handle)"],
      listRule: "",
      viewRule: "",
    });
    productsId = products.id;

    productIds = [];
    for (let i = 1; i <= 5; i++) {
      const p = await owner.collection("dyn_products").create({
        title: "Product " + i,
        handle: "product-" + i,
      });
      productIds.push(p.id);
    }

    const users = await owner.collections.getOne("users");
    await owner.collection("users").create({
      email: CUSTOMER.email,
      password: CUSTOMER.password,
      passwordConfirm: CUSTOMER.password,
      verified: true,
    });

    const client = await owner.oauth2Clients.create({
      name: "Integration dynamite",
      clientId: CLIENT_ID,
      type: "public",
      collectionRef: users.id,
      redirectURIs: [REDIRECT],
      postLogoutRedirectURIs: [APP + "/"],
      scopes: ["openid", "email", "profile", "offline_access"],
      firstParty: true,
    });

    const keys = owner.oauth2Clients.apiKeys(client.id);
    publicKey = (
      await keys.create({
        name: "public",
        kind: "public",
        permissions: { collections: { [productsId]: ["list", "view"] } },
      })
    ).token;
    privateKey = (
      await keys.create({
        name: "private",
        kind: "private",
        buyerContext: "required",
        permissions: { collections: { [productsId]: ["list", "view"] } },
      })
    ).token;
  });

  test("storefront public key: typed GraphQL pagination == REST", async function () {
    const storefront = createStorefrontClient({ url, publicKey });

    const rest = await storefront.collection("dyn_products").getFullList({ sort: "handle" });
    assert.deepEqual(
      rest.map((r) => r.id),
      productIds,
    );

    const nodes: Array<Product> = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const data: ResultOf<typeof PRODUCTS> = await storefront.query(PRODUCTS, {
        variables: { first: 2, after },
      });
      assert.equal(data.dynProducts.totalCount, 5);
      nodes.push(...flattenConnection(data.dynProducts));
      pages++;
      if (!data.dynProducts.pageInfo.hasNextPage) {
        break;
      }
      after = data.dynProducts.pageInfo.endCursor;
    }
    assert.equal(pages, 3);

    assert.deepEqual(
      nodes.map((n) => {
        const gid = fromGlobalId(n.id);
        assert.equal(gid.collectionName, "dyn_products");
        return { id: gid.id, title: n.title, handle: n.handle };
      }),
      rest.map((r) => ({ id: r.id, title: r.title, handle: r.handle })),
    );

    // the GraphQL errors are thrown by query() and returned by graphql()
    const invalid = gql(`{ dynProducts(first: 1) { nope } }`);
    await expect(storefront.query(invalid)).rejects.toBeInstanceOf(GraphQLError);
    const result = await storefront.graphql(invalid);
    assert.isNotEmpty(result.errors);
  });

  test("storefront private key: buyer IP from the request context, cached queries", async function () {
    const cache = new MemoryCache();
    const requestContext = createRequestContext({
      request: new Request(APP + "/", { headers: { "x-forwarded-for": "203.0.113.9" } }),
      cache,
    });

    const storefront = createStorefrontClient({ url, privateKey, requestContext });
    assert.equal(storefront.client.buyerIp, "203.0.113.9");

    let graphqlRequests = 0;
    storefront.client.beforeSend = (reqURL, options) => {
      if (reqURL.endsWith("/api/graphql")) {
        graphqlRequests++;
      }
      return { url: reqURL, options };
    };

    const first = await storefront.query(PRODUCTS, {
      variables: { first: 5 },
      cache: Cache.long(),
    });
    const second = await storefront.query(PRODUCTS, {
      variables: { first: 5 },
      cache: Cache.long(),
    });
    assert.deepEqual(first, second);
    assert.equal(graphqlRequests, 1, "the second query is served from the cache");
    assert.equal(first.dynProducts.totalCount, 5);

    // without the buyer IP the server rejects the private key
    const noBuyer = createStorefrontClient({
      url,
      privateKey,
      requestContext: createRequestContext({ request: new Request(APP + "/") }),
      buyerContext: "none",
    });
    await expect(noBuyer.query(PRODUCTS, { variables: { first: 1 } })).rejects.toMatchObject({
      status: 401,
    });
  });

  test("customer account SSR: login -> callback -> account page -> refresh -> logout (httpOnly cookie session)", async function () {
    const jar = new CookieJar(); // the issuer cookies of the "browser"
    let cookies = ""; // the app cookies of the "browser"

    const account = (request: Request) => {
      const requestContext = createRequestContext({ request });
      return {
        requestContext,
        customer: createCustomerAccountClient({
          url,
          collection: "users",
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          postLogoutRedirectUri: APP + "/",
          scopes: ["openid", "email", "offline_access"],
          publicKey,
          requestContext,
        }),
      };
    };

    // GET /account/login
    const login = await account(new Request(APP + "/account/login")).customer.loginRedirect({
      returnTo: "/account/orders",
    });
    assert.equal(login.status, 302);
    cookies = browserCookies(cookies, login.headers.getSetCookie());
    assert.include(cookies, "pb_auth_flow=");

    // hosted login in the "browser"
    const callbackURL = await followHostedFlow(
      login.headers.get("location")!,
      REDIRECT,
      { identity: CUSTOMER.email, password: CUSTOMER.password },
      jar,
    );

    // GET /account/callback
    const callback = await account(
      new Request(callbackURL, { headers: { cookie: cookies } }),
    ).customer.callbackRedirect();
    assert.equal(callback.headers.get("location"), "/account/orders");
    const callbackCookies = callback.headers.getSetCookie();
    assert.isTrue(callbackCookies.some((c) => c.startsWith("pb_auth=") && /HttpOnly/i.test(c)));
    cookies = browserCookies(cookies, callbackCookies);
    assert.notInclude(cookies, "pb_auth_flow=", "the login flow cookie is cleared");

    // GET /account/orders
    const page = account(new Request(APP + "/account/orders", { headers: { cookie: cookies } }));
    assert.isTrue(page.customer.isLoggedIn());
    const me = await page.customer.me();
    assert.equal(me.kind, "customer");
    assert.equal(me.record?.email, CUSTOMER.email);
    const info = await page.customer.userinfo();
    assert.equal(info.email, CUSTOMER.email);

    // the customer token + the key of the same client
    const viaToken = await page.customer.client.collection("dyn_products").getList(1, 1);
    assert.equal(viaToken.totalItems, 5);

    const headers = new Headers();
    page.requestContext.applyResponseHeaders(headers);
    assert.equal(headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
    assert.isEmpty(headers.getSetCookie(), "nothing changed");

    // a request with an expired access token is refreshed (rotation) and the cookie updated
    const refreshed = account(new Request(APP + "/account", { headers: { cookie: cookies } }));
    const store = refreshed.customer.client.authStore;
    const oldRefreshToken = store.refreshToken;
    store.save(store.token, store.record, { ...store.meta, expiresAt: 1 });
    assert.isFalse(refreshed.customer.isLoggedIn());
    assert.isTrue(await refreshed.customer.account.refresh());
    assert.notEqual(store.refreshToken, oldRefreshToken);
    const refreshHeaders = new Headers();
    refreshed.requestContext.applyResponseHeaders(refreshHeaders);
    assert.isTrue(refreshHeaders.getSetCookie().some((c) => c.startsWith("pb_auth=")));
    cookies = browserCookies(cookies, refreshHeaders.getSetCookie());

    // the rotated-out refresh token is rejected
    const reuse = await raw(url + "/oauth2/users/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: oldRefreshToken,
      }).toString(),
    });
    assert.equal(reuse.status, 400);

    // GET /account/logout
    const accessToken = account(new Request(APP, { headers: { cookie: cookies } })).customer.client
      .authStore.token;
    const logout = await account(
      new Request(APP + "/account/logout", { headers: { cookie: cookies } }),
    ).customer.logoutRedirect();
    const endSession = logout.headers.get("location")!;
    assert.include(endSession, "/oauth2/users/logout?");
    cookies = browserCookies(cookies, logout.headers.getSetCookie());
    assert.notInclude(cookies, "pb_auth=");

    const back = await followHostedFlow(endSession, APP + "/", undefined, jar);
    assert.isTrue(back.startsWith(APP + "/"));

    const after = await raw(url + "/api/permissions/me", {
      headers: { Authorization: accessToken },
    });
    assert.equal(after.status, 401);
  });
});
