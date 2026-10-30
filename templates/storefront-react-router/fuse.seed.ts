// The fuse seed of the storefront (`dynamite dev` / `dynamite codegen --fuse`): a "products"
// collection with a few products, a demo customer and the storefront OAuth2 client with a public
// and a private API key. The returned variables are exposed to the app (process.env).
//
// APP_URL (comma separated) are the registered app origins (default http://localhost:3000).
import type { FuseSeedContext } from "pocketbomb-fuse/node";

export const DEMO_CUSTOMER = { email: "demo@example.com", password: "DemoPass123456" };
export const CLIENT_ID = "storefront";

export default async function seed(context: FuseSeedContext): Promise<Record<string, string>> {
  const pb = await context.signInOwner();
  await pb.settings.update({ meta: { appURL: context.url, appName: "PocketBomb Storefront" } });

  const products = await pb.collections.create({
    name: "products",
    type: "base",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "handle", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "price", type: "number" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_products_handle ON products (handle)"],
    listRule: "",
    viewRule: "",
  });

  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, "0");
    await pb.collection("products").create({
      title: "Product " + n,
      handle: "product-" + n,
      description: "The product number " + i + ".",
      price: i * 10,
    });
  }

  const users = await pb.collections.getOne("users");
  await pb.collection("users").create({
    email: DEMO_CUSTOMER.email,
    password: DEMO_CUSTOMER.password,
    passwordConfirm: DEMO_CUSTOMER.password,
    verified: true,
  });

  const origins = (process.env.APP_URL || "http://localhost:3000")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const client = await pb.oauth2Clients.create({
    name: "Storefront",
    clientId: CLIENT_ID,
    type: "public",
    collectionRef: users.id,
    redirectURIs: origins.map((o) => o + "/account/callback"),
    postLogoutRedirectURIs: origins.map((o) => o + "/"),
    scopes: ["openid", "email", "offline_access"],
    firstParty: true,
  });

  const keys = pb.oauth2Clients.apiKeys(client.id);
  const permissions = { collections: { [products.id]: ["list", "view"] } };
  const publicKey = (await keys.create({ name: "storefront public", kind: "public", permissions }))
    .token;
  const privateKey = (
    await keys.create({
      name: "storefront server",
      kind: "private",
      buyerContext: "required",
      permissions,
    })
  ).token;

  return {
    POCKETBOMB_PUBLIC_KEY: publicKey,
    POCKETBOMB_PRIVATE_KEY: privateKey,
    POCKETBOMB_CLIENT_ID: CLIENT_ID,
    DEMO_CUSTOMER_EMAIL: DEMO_CUSTOMER.email,
    DEMO_CUSTOMER_PASSWORD: DEMO_CUSTOMER.password,
  };
}
