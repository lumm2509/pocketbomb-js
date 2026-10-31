# pocketbomb-dynamite

The PocketBomb storefront framework (similar to Hydrogen).

```ts
import { createRequestContext, createStorefrontClient, gql, MemoryCache } from "pocketbomb-dynamite";
import { createCustomerAccountClient } from "pocketbomb-dynamite/customer-account";

const cache = new MemoryCache();

export async function handle(request: Request) {
  const context = createRequestContext({ request, cache }); // buyer IP, cookie session, cache
  const storefront = createStorefrontClient({ url, privateKey, requestContext: context });
  const customer = createCustomerAccountClient({
    url, collection: "users", clientId, redirectUri, requestContext: context,
  });

  const path = new URL(request.url).pathname;
  if (path === "/account/login") return customer.loginRedirect({ returnTo: "/account" });
  if (path === "/account/callback") return customer.callbackRedirect();
  if (path === "/account/logout") return customer.logoutRedirect();

  const { products } = await storefront.query(PRODUCTS, { variables: { first: 10 } });
  const response = new Response(render(products, customer.isLoggedIn()));
  context.applyResponseHeaders(response.headers); // Set-Cookie + private caching
  return response;
}

const PRODUCTS = gql<{ products: { nodes: Array<{ id: string; title: string }> } }, { first: number }>(
  `query Products($first: Int) { products(first: $first) { nodes { id title } } }`,
);
```

Entries: `pocketbomb-dynamite` (core + storefront client + GraphQL), `pocketbomb-dynamite/customer-account`,
`pocketbomb-dynamite/graphql` (gql.tada `graphql()` typed by `dynamite codegen`), `pocketbomb-dynamite/react`
(DynamiteProvider, useStorefront, useCustomer, useStorefrontQuery, Pagination, FileImage), `pocketbomb-dynamite/vite`
(env + private key guard, dev proxy, codegen, fuse) and `pocketbomb-dynamite/ts-plugin` (graphqlsp for the editor).

CLI: `dynamite codegen [--watch] [--fuse --seed <module>]`, `dynamite dev [--seed] [--entry server.ts]`,
`dynamite check [--schema <file>]`, `dynamite info`.

## Global ids

GraphQL is read-only and its `id` fields are Relay global ids: base64url of `{collectionName}:{recordId}`. The REST
API takes record ids, so convert them when a GraphQL result drives a write:

```ts
import { fromGlobalId, toGlobalId } from "pocketbomb-dynamite/graphql";

const { todos } = await customer.query(TODOS);                       // todos.nodes[0].id = "dG9kb3M6NDFoa2s..."
const { collectionName, id } = fromGlobalId(todos.nodes[0].id);      // "todos", "41hkk..." (throws if it is invalid)
await customer.client.collection(collectionName).update(id, { done: true });

await storefront.query(TODO, { variables: { id: toGlobalId("todos", id) } }); // the other way around
```

## Checking the documents

`tsc` types the results of the `graphql()` documents but doesn't validate the documents themselves (an unknown field
is flagged only by the editor plugin). `dynamite check` validates every `graphql()` document of the project
against `.dynamite/schema.graphql` and fails with `file:line:column`; add it to your typecheck script.
It needs `typescript` installed in the project.
