// Server-only PocketBomb clients (server components and route handlers).
import {
  createRequestContext,
  createStorefrontClient,
  getBuyerIp,
  MemoryCache,
  type IncomingRequest,
  type RequestContext,
} from "@pocketbomb/dynamite";
import { createCustomerAccountClient } from "@pocketbomb/dynamite/customer-account";

const cache = new MemoryCache();

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing the " + name + " environment variable.");
  }
  return value;
}

export const SESSION_COOKIE = "shop_session";

/**
 * The request context of a route handler request or of the server component headers.
 */
export function requestContext(request: IncomingRequest): RequestContext {
  return createRequestContext({
    request,
    // the end-user IP forwarded by the Next.js server (x-forwarded-for)
    buyerIp: getBuyerIp(request, { buyerIpHeader: "x-forwarded-for" }) || "127.0.0.1",
    cache,
    session: {
      key: SESSION_COOKIE,
      cookieOptions: { secure: process.env.NODE_ENV === "production" && !!process.env.HTTPS },
    },
  });
}

/** The private storefront client (server-only key + the buyer IP). */
export function storefront(context: RequestContext) {
  return createStorefrontClient({
    url: env("POCKETBOMB_URL"),
    privateKey: env("POCKETBOMB_PRIVATE_KEY"),
    requestContext: context,
  });
}

/** The customer account of the httpOnly session cookie. */
export function customer(context: RequestContext, origin: string) {
  return createCustomerAccountClient({
    url: env("POCKETBOMB_URL"),
    collection: "users",
    clientId: process.env.POCKETBOMB_CLIENT_ID || "example_shop",
    redirectUri: origin + "/account/callback",
    postLogoutRedirectUri: origin + "/",
    scopes: ["openid", "email", "offline_access"],
    publicKey: process.env.POCKETBOMB_PUBLIC_KEY,
    requestContext: context,
  });
}

/** The browser configuration (public values only). */
export function browserConfig() {
  return { url: env("POCKETBOMB_URL"), publicKey: env("POCKETBOMB_PUBLIC_KEY") };
}
