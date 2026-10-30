import { assert, describe, expect, test } from "vitest";
import { Cache, MemoryCache } from "../core/cache";
import { createRequestContext } from "../core/request-context";
import { gql, GraphQLError } from "../graphql/graphql";
import { mockFetch } from "../test-utils";
import { createStorefrontClient } from "./storefront";

const url = "http://pb.local";

const ARTICLES = gql<{ articles: { totalCount: number } }, { first?: number }>(
  `query Articles($first: Int) { articles(first: $first) { totalCount } }`,
);

function graphqlMock(counter = { n: 0 }) {
  return mockFetch((req) =>
    req.url === url + "/api/graphql"
      ? { body: { data: { articles: { totalCount: ++counter.n } } } }
      : undefined,
  );
}

describe("createStorefrontClient()", function () {
  test("public key: headers, REST, files and URLs", async function () {
    const mock = mockFetch((req) =>
      req.url.startsWith(url + "/api/collections/articles/records")
        ? { body: { page: 1, perPage: 30, totalItems: 1, totalPages: 1, items: [{ id: "a1" }] } }
        : undefined,
    );
    const storefront = createStorefrontClient({ url, publicKey: "pb_pk_1", fetch: mock.fetch });

    const list = await storefront.collection("articles").getList();
    assert.equal(list.items[0].id, "a1");
    assert.equal(mock.requests[0].headers["X-PB-Public-Key"], "pb_pk_1");
    assert.isUndefined(mock.requests[0].headers["X-PB-Private-Key"]);

    assert.deepEqual(storefront.getPublicHeaders(), { "X-PB-Public-Key": "pb_pk_1" });
    assert.equal(storefront.getApiURL("/api/graphql"), url + "/api/graphql");
    assert.equal(storefront.getApiURL(), url);
    assert.equal(
      storefront.getFileURL({ id: "r1", collectionName: "articles" }, "a.png", { thumb: "10x10" }),
      url + "/api/files/articles/r1/a.png?thumb=10x10",
    );
    assert.equal(storefront.client.publicKey, "pb_pk_1");
  });

  test("appProxy(): the proxy path with the client key headers", async function () {
    const seen: Array<{ url: string; headers: Headers; method?: string }> = [];
    const fetchMock = (async (input: any, init: any) => {
      seen.push({ url: String(input), headers: new Headers(init.headers), method: init.method });
      return new Response("ok");
    }) as typeof fetch;

    const publicClient = createStorefrontClient({ url, publicKey: "pb_pk_1", fetch: fetchMock });
    const res = await publicClient.appProxy("/apps/reviews/x?a=1", {
      method: "POST",
      headers: { "x-custom": "1" },
    });
    assert.equal(await res.text(), "ok");
    assert.equal(seen[0].url, url + "/apps/reviews/x?a=1");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers.get("x-custom"), "1");
    assert.equal(seen[0].headers.get("X-PB-Public-Key"), "pb_pk_1");

    const privateClient = createStorefrontClient({
      url,
      privateKey: "pb_sk_1",
      buyerIp: "203.0.113.7",
      fetch: fetchMock,
    });
    await privateClient.appProxy("/a/x");
    assert.equal(seen[1].headers.get("X-PB-Private-Key"), "pb_sk_1");
    assert.equal(seen[1].headers.get("X-PB-Buyer-IP"), "203.0.113.7");
    assert.isNull(seen[1].headers.get("X-PB-Public-Key"));
  });

  test("private key: buyer IP from the request context, no auto cancellation", async function () {
    const mock = graphqlMock();
    const requestContext = createRequestContext({
      request: new Request(url, { headers: { "x-forwarded-for": "203.0.113.7" } }),
    });
    const storefront = createStorefrontClient({
      url,
      privateKey: "pb_sk_1",
      requestContext,
      fetch: mock.fetch,
    });

    const results = await Promise.all([storefront.query(ARTICLES), storefront.query(ARTICLES)]);
    assert.deepEqual(
      results.map((r) => r.articles.totalCount).toSorted(),
      [1, 2],
      "concurrent queries are not cancelled",
    );
    assert.equal(mock.requests[0].headers["X-PB-Private-Key"], "pb_sk_1");
    assert.equal(mock.requests[0].headers["X-PB-Buyer-IP"], "203.0.113.7");
    assert.deepEqual(storefront.getPublicHeaders(), {});

    // explicit buyer IP wins
    const explicit = createStorefrontClient({
      url,
      privateKey: "pb_sk_1",
      buyerIp: "1.1.1.1",
      requestContext,
    });
    assert.equal(explicit.client.buyerIp, "1.1.1.1");
  });

  test("private key guards", function () {
    assert.throws(() => createStorefrontClient({ url, privateKey: "pb_sk_1" }), /buyerIp/);
    assert.equal(
      createStorefrontClient({ url, privateKey: "pb_sk_1", buyerContext: "none" }).client.buyerIp,
      "",
    );
    assert.throws(() => createStorefrontClient({ url } as any), /publicKey/);

    (globalThis as any).document = {};
    try {
      assert.throws(
        () => createStorefrontClient({ url, privateKey: "pb_sk_1", buyerContext: "none" }),
        /browser/,
      );
      createStorefrontClient({ url, publicKey: "pb_pk_1" });
    } finally {
      delete (globalThis as any).document;
    }
  });

  test("graphql() caching: default short strategy with a cache store, per query override, errors not cached", async function () {
    const counter = { n: 0 };
    const mock = graphqlMock(counter);
    const cache = new MemoryCache();
    const storefront = createStorefrontClient({
      url,
      publicKey: "pb_pk_1",
      cache,
      fetch: mock.fetch,
    });

    const a = await storefront.graphql(ARTICLES, { variables: { first: 1 } });
    const b = await storefront.graphql(ARTICLES, { variables: { first: 1 } });
    assert.deepEqual(a, b);
    assert.equal(counter.n, 1, "cached");

    await storefront.graphql(ARTICLES, { variables: { first: 2 } });
    assert.equal(counter.n, 2, "other variables -> other cache key");

    await storefront.graphql(ARTICLES, { variables: { first: 1 }, cache: Cache.none() });
    assert.equal(counter.n, 3, "no-store override");

    // another key -> another cache scope
    const other = createStorefrontClient({ url, publicKey: "pb_pk_2", cache, fetch: mock.fetch });
    await other.graphql(ARTICLES, { variables: { first: 1 } });
    assert.equal(counter.n, 4);
    assert.isFalse(
      [...(cache as any).entries.keys()].some((k: string) => k.includes("pb_pk_")),
      "the cache keys don't contain the API keys",
    );

    // GraphQL errors are not cached
    let calls = 0;
    const failing = mockFetch(() => ({ body: { data: null, errors: [{ message: "boom" }] } }));
    const errClient = createStorefrontClient({
      url,
      publicKey: "pb_pk_3",
      cache,
      fetch: async (...args) => {
        calls++;
        return failing.fetch(...args);
      },
    });
    await expect(errClient.query(ARTICLES)).rejects.toBeInstanceOf(GraphQLError);
    await expect(errClient.query(ARTICLES)).rejects.toBeInstanceOf(GraphQLError);
    assert.equal(calls, 2);
  });

  test("graphql() without a cache store is never cached; the request context cache is used", async function () {
    const counter = { n: 0 };
    const mock = graphqlMock(counter);
    const storefront = createStorefrontClient({ url, publicKey: "pb_pk_1", fetch: mock.fetch });
    await storefront.graphql(ARTICLES, { cache: Cache.long() });
    await storefront.graphql(ARTICLES, { cache: Cache.long() });
    assert.equal(counter.n, 2);

    const requestContext = createRequestContext({
      request: new Request(url),
      cache: new MemoryCache(),
    });
    const contextual = createStorefrontClient({
      url,
      publicKey: "pb_pk_1",
      requestContext,
      fetch: mock.fetch,
    });
    await contextual.query(ARTICLES);
    await contextual.query(ARTICLES);
    assert.equal(counter.n, 3);
  });
});
