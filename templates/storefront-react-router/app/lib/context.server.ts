// The per-request PocketBomb context of the loaders and actions (created by server.ts).
import {
  createRequestContext,
  createStorefrontClient,
  MemoryCache,
  type RequestContext,
  type StorefrontClient,
} from "@pocketbomb/dynamite";
import {
  createCustomerAccountClient,
  type CustomerAccountClient,
} from "@pocketbomb/dynamite/customer-account";

export interface AppContext {
  [key: string]: unknown;
  requestContext: RequestContext;
  /** The storefront client of the loaders (server-only private key + the buyer IP). */
  storefront: StorefrontClient;
  /** The customer account (httpOnly cookie session). */
  customer: CustomerAccountClient;
}

declare module "react-router" {
  interface AppLoadContext extends AppContext {}
}

// the storefront queries cache shared by the requests of the process
const cache = new MemoryCache();

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing the " + name + " environment variable.");
  }
  return value;
}

/**
 * Creates the PocketBomb context of a request.
 */
export function createAppContext(request: Request, buyerIp: string): AppContext {
  const url = env("POCKETBOMB_URL");
  const origin = new URL(request.url).origin;

  const requestContext = createRequestContext({
    request,
    buyerIp,
    cache,
    session: { key: "storefront_session", cookieOptions: { secure: origin.startsWith("https:") } },
  });

  return {
    requestContext,
    storefront: createStorefrontClient({
      url,
      privateKey: env("POCKETBOMB_PRIVATE_KEY"),
      requestContext,
    }),
    customer: createCustomerAccountClient({
      url,
      collection: "users",
      clientId: process.env.POCKETBOMB_CLIENT_ID || "storefront",
      redirectUri: origin + "/account/callback",
      postLogoutRedirectUri: origin + "/",
      scopes: ["openid", "email", "offline_access"],
      publicKey: process.env.POCKETBOMB_PUBLIC_KEY,
      requestContext,
    }),
  };
}
