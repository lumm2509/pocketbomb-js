import { Client } from "pocketbomb-primer";
import { assert, describe, expect, expectTypeOf, test } from "vitest";
import { mockFetch } from "../test-utils";
import {
  flattenConnection,
  fromGlobalId,
  gql,
  documentText,
  executeGraphQL,
  graphql,
  GraphQLError,
  POCKETBOMB_SCALARS,
  query,
  toGlobalId,
  unwrapGraphQLResponse,
  type ResultOf,
  type VariablesOf,
} from "./graphql";

describe("gql()", function () {
  test("returns the source with each fragment appended once", function () {
    const fragment = gql(`fragment A on Article { id }`);
    const doc = gql<{ a: number }, { first: number }>(`query Q { articles { ...A } }`, [
      fragment,
      fragment,
    ]);

    assert.equal(doc, "query Q { articles { ...A } }\nfragment A on Article { id }");
    assert.equal(gql("query { a }"), "query { a }");

    // an already included fragment is not appended again
    const composed = gql(doc, [fragment]);
    assert.equal(String(composed), String(doc));

    expectTypeOf<ResultOf<typeof doc>>().toEqualTypeOf<{ a: number }>();
    expectTypeOf<VariablesOf<typeof doc>>().toEqualTypeOf<{ first: number }>();
  });

  test("scalars", function () {
    assert.deepEqual(POCKETBOMB_SCALARS, { ID: "string", DateTime: "string", JSON: "unknown" });
  });
});

describe("flattenConnection()", function () {
  test("nodes, edges and missing connections", function () {
    assert.deepEqual(flattenConnection({ nodes: [1, 2] }), [1, 2]);
    assert.deepEqual(flattenConnection({ edges: [{ node: "a" }, { node: "b" }] }), ["a", "b"]);
    assert.deepEqual(flattenConnection({}), []);
    assert.deepEqual(flattenConnection(null), []);
    assert.deepEqual(flattenConnection(undefined), []);
  });
});

describe("global ids", function () {
  test("toGlobalId() / fromGlobalId() round trip (base64url, unicode)", function () {
    const id = toGlobalId("articles", "abc123");
    assert.equal(id, Buffer.from("articles:abc123").toString("base64url"));
    assert.deepEqual(fromGlobalId(id), { collectionName: "articles", id: "abc123" });

    const unicode = toGlobalId("статии", "x:y");
    assert.deepEqual(fromGlobalId(unicode), { collectionName: "статии", id: "x:y" });
  });

  test("fromGlobalId() rejects invalid ids", function () {
    assert.throws(() => fromGlobalId(""), /Invalid/);
    assert.throws(() => fromGlobalId(Buffer.from("noseparator").toString("base64url")), /Invalid/);
    assert.throws(() => fromGlobalId(Buffer.from(":id").toString("base64url")), /Invalid/);
    assert.throws(() => fromGlobalId(Buffer.from("c:").toString("base64url")), /Invalid/);
    assert.throws(() => fromGlobalId("%%%"), /Invalid/);
  });
});

describe("runtime client", function () {
  const ARTICLES = gql<{ articles: { totalCount: number } }, { first: number }>(
    `query Articles($first: Int) { articles(first: $first) { totalCount } }`,
  );

  test("executeGraphQL() sends the document, variables and operationName", async function () {
    const mock = mockFetch(() => ({ body: { data: { articles: { totalCount: 3 } } } }));
    const client = new Client("http://test.local", { publicKey: "pb_pk_1", fetch: mock.fetch });

    const result = await executeGraphQL(client, ARTICLES, {
      variables: { first: 2 },
      operationName: "Articles",
    });

    assert.deepEqual(result.data, { articles: { totalCount: 3 } });
    assert.equal(mock.requests[0].url, "http://test.local/api/graphql");
    assert.equal(mock.requests[0].method, "POST");
    assert.equal(mock.requests[0].headers["X-PB-Public-Key"], "pb_pk_1");
    assert.deepEqual(JSON.parse(mock.requests[0].body), {
      query: ARTICLES,
      variables: { first: 2 },
      operationName: "Articles",
    });
  });

  test("query() returns the data or throws a GraphQLError", async function () {
    const ok = mockFetch(() => ({ body: { data: { articles: { totalCount: 1 } } } }));
    const data = await query(new Client("http://x", { fetch: ok.fetch }), ARTICLES);
    assert.equal(data.articles.totalCount, 1);

    const failing = mockFetch(() => ({
      body: { data: null, errors: [{ message: "a" }, { message: "b" }] },
    }));
    const err = await query(new Client("http://x", { fetch: failing.fetch }), ARTICLES).catch(
      (e) => e,
    );
    assert.instanceOf(err, GraphQLError);
    assert.equal(err.message, "a\nb");
    assert.lengthOf(err.errors, 2);
    assert.isNull(err.data);

    // the HTTP errors are ClientResponseError
    const unauthorized = mockFetch(() => ({ status: 401, body: { message: "missing key" } }));
    await expect(
      query(new Client("http://x", { fetch: unauthorized.fetch }), ARTICLES),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("unwrapGraphQLResponse()", function () {
    assert.deepEqual(unwrapGraphQLResponse({ data: { a: 1 } }), { a: 1 });
    assert.deepEqual(unwrapGraphQLResponse({ data: { a: 1 }, errors: [] }), { a: 1 });
    assert.throws(() => unwrapGraphQLResponse({ errors: [{ message: "x" }] }), GraphQLError);
    assert.equal(new GraphQLError([]).message, "GraphQL error");
  });
});

describe("gql.tada graphql()", function () {
  test("returns a document node; documentText() prints it with its fragments", async function () {
    const fragment = graphql(`
      fragment F on Article {
        id
      }
    `);
    const doc = graphql(
      `
        query Q {
          articles {
            nodes {
              ...F
            }
          }
        }
      `,
      [fragment],
    );

    assert.equal(typeof doc, "object");
    // (untyped here: the package itself has no generated schema env)
    assert.equal((doc as { kind: string }).kind, "Document");
    const text = documentText(doc);
    assert.include(text, "query Q");
    assert.include(text, "fragment F on Article");
    assert.equal(documentText("{ a }"), "{ a }");

    const mock = mockFetch(() => ({ body: { data: { articles: { nodes: [] } } } }));
    const client = new Client("http://x", { fetch: mock.fetch });
    await executeGraphQL(client, doc);
    assert.equal(JSON.parse(mock.requests[0].body).query, text);
  });
});
