// Node.js script: the storefront client with the server-only private key, the end-user IP
// derived from the incoming request by the request context and a cached GraphQL query.
//
// Usage: POCKETBOMB_URL=... POCKETBOMB_PRIVATE_KEY=pb_sk_... node src/node.ts
// (`pnpm smoke` starts a seeded PocketBomb server and runs it.)
import {
  Cache,
  createRequestContext,
  createStorefrontClient,
  flattenConnection,
  fromGlobalId,
  MemoryCache,
} from "@pocketbomb/dynamite";
import { PRODUCTS } from "./queries.ts";

const url = process.env.POCKETBOMB_URL;
const privateKey = process.env.POCKETBOMB_PRIVATE_KEY;
if (!url || !privateKey) {
  console.error("POCKETBOMB_URL and POCKETBOMB_PRIVATE_KEY are required.");
  process.exit(1);
}

const cache = new MemoryCache();

// e.g. inside your server request handler
const request = new Request("http://shop.example.com/products", {
  headers: { "x-forwarded-for": "203.0.113.10" },
});
const context = createRequestContext({ request, cache });
const storefront = createStorefrontClient({ url, privateKey, requestContext: context });

const data = await storefront.query(PRODUCTS, { variables: { first: 10 }, cache: Cache.short() });
const products = flattenConnection(data.products);

// the same records with the REST API
const rest = await storefront.collection("products").getFullList({ sort: "handle" });

const graphqlIds = products.map((p) => fromGlobalId(p.id).id);
if (JSON.stringify(graphqlIds) !== JSON.stringify(rest.map((r) => r.id))) {
  throw new Error("GraphQL and REST returned different products");
}

console.log(
  `buyer IP ${context.buyerIp}: ${data.products.totalCount} products (${products
    .map((p) => p.title)
    .join(", ")}), cached entries: ${cache.size}`,
);
