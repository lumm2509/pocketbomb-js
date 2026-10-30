// The fuse seed of the examples smoke runs on a fresh PocketBomb server
// (a "products" collection, a customer and the "example_shop" OAuth2 client with
// a public and a private API key) and returns them as environment variables.
import type { FuseSeedContext } from "pocketbomb-fuse/node";

export const EXAMPLE_CLIENT_ID = "example_shop";
export const EXAMPLE_WEB_REDIRECT = "http://localhost:5173/account/callback";
export const EXAMPLE_APP_REDIRECT = "pocketbombshop://auth/callback";
export const EXAMPLE_CUSTOMER = {
  email: "example.customer@example.com",
  password: "ExamplePass12345",
};

/**
 * The fuse seed of the examples (`node scripts/pocketbomb-server.ts --seed scripts/example-fixtures.ts`).
 */
export default async function seedExampleFixtures(
  context: FuseSeedContext,
): Promise<{ [key: string]: string }> {
  const url = context.url;
  const pb = await context.signInOwner();

  await pb.settings.update({ meta: { appURL: url } });

  const products = await pb.collections.create({
    name: "products",
    type: "base",
    fields: [
      { name: "title", type: "text" },
      { name: "handle", type: "text" },
    ],
    listRule: "",
    viewRule: "",
  });
  for (let i = 1; i <= 3; i++) {
    await pb.collection("products").create({ title: "Product " + i, handle: "product-" + i });
  }

  const users = await pb.collections.getOne("users");
  await pb.collection("users").create({
    email: EXAMPLE_CUSTOMER.email,
    password: EXAMPLE_CUSTOMER.password,
    passwordConfirm: EXAMPLE_CUSTOMER.password,
    verified: true,
  });

  const client = await pb.oauth2Clients.create({
    name: "Example shop",
    clientId: EXAMPLE_CLIENT_ID,
    type: "public",
    collectionRef: users.id,
    redirectURIs: [EXAMPLE_WEB_REDIRECT, EXAMPLE_APP_REDIRECT],
    postLogoutRedirectURIs: [EXAMPLE_WEB_REDIRECT, EXAMPLE_APP_REDIRECT],
    scopes: ["openid", "email", "offline_access"],
    firstParty: true,
  });

  const keys = pb.oauth2Clients.apiKeys(client.id);
  const permissions = { collections: { [products.id]: ["list", "view"] } };
  const publicKey = (await keys.create({ name: "public", kind: "public", permissions })).token;
  const privateKey = (
    await keys.create({ name: "private", kind: "private", buyerContext: "required", permissions })
  ).token;

  return {
    POCKETBOMB_PUBLIC_KEY: publicKey,
    POCKETBOMB_PRIVATE_KEY: privateKey,
    POCKETBOMB_CLIENT_ID: EXAMPLE_CLIENT_ID,
    POCKETBOMB_WEB_REDIRECT: EXAMPLE_WEB_REDIRECT,
    POCKETBOMB_APP_REDIRECT: EXAMPLE_APP_REDIRECT,
    POCKETBOMB_CUSTOMER_EMAIL: EXAMPLE_CUSTOMER.email,
    POCKETBOMB_CUSTOMER_PASSWORD: EXAMPLE_CUSTOMER.password,
  };
}
