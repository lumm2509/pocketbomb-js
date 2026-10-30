import { CookieAuthStore, type CookieAuthStoreConfig } from "@pocketbomb/primer";
import { getBuyerIp, type BuyerIpOptions } from "./buyer-ip";
import type { CacheStore, WaitUntil } from "./cache";

/**
 * The incoming request (only the headers are required; e.g. a Fetch API `Request`).
 */
export type IncomingRequest = { headers: Pick<Headers, "get"> } & Partial<
  Pick<Request, "url" | "method" | "signal">
>;

export interface RequestContextOptions extends BuyerIpOptions {
  /**
   * The incoming request.
   */
  request: IncomingRequest;

  /**
   * The end-user IP (default to the one of the request headers, see {@link getBuyerIp}).
   */
  buyerIp?: string;

  /**
   * The session cookie options (name, attributes and the optional encode/decode hooks,
   * e.g. to sign or encrypt the cookie). The cookie is `HttpOnly; Secure; SameSite=Lax` by default.
   */
  session?: Omit<CookieAuthStoreConfig, "request">;

  /**
   * The cache store of the storefront queries.
   */
  cache?: CacheStore;

  /**
   * The background work scheduler of the runtime (e.g. the edge `ctx.waitUntil`).
   */
  waitUntil?: WaitUntil;
}

/**
 * The per-request context of a server rendered PocketBomb app (see {@link createRequestContext}).
 */
export interface RequestContext {
  readonly request: IncomingRequest;

  /**
   * The end-user IP (the `X-PB-Buyer-IP` of the private key requests; empty if unknown).
   */
  readonly buyerIp: string;

  /**
   * The cookie session: the customer account auth state and the login flow state
   * (use it as the `authStore` and `session` of the customer account client).
   */
  readonly session: CookieAuthStore;

  readonly cache?: CacheStore;
  readonly waitUntil?: WaitUntil;
  readonly signal?: AbortSignal;

  /**
   * Marks the response as private and uncacheable (e.g. it holds customer data).
   */
  markPersonalized(): void;

  /**
   * Adds the session `Set-Cookie` headers (if the session changed) to the response headers;
   * the responses that set cookies or are personalized are marked as
   * `Cache-Control: private, no-store`.
   */
  applyResponseHeaders(headers: Headers): void;
}

/**
 * Creates the per-request context (buyer IP, cookie session, cache) of a server rendered app.
 *
 * ```ts
 * export async function handle(request: Request) {
 *   const context = createRequestContext({ request, cache });
 *   const storefront = createStorefrontClient({ url, privateKey, requestContext: context });
 *
 *   const response = new Response(await render(storefront));
 *   context.applyResponseHeaders(response.headers);
 *   return response;
 * }
 * ```
 */
export function createRequestContext(options: RequestContextOptions): RequestContext {
  const request = options.request;
  // SameSite=Lax: the session must be sent with the navigations that follow the issuer
  // redirect back to the app (e.g. callback -> account page)
  const session = new CookieAuthStore({
    ...options.session,
    cookieOptions: { sameSite: "lax", ...options.session?.cookieOptions },
    request: request as any,
  });

  let personalized = false;

  return {
    request,
    buyerIp: options.buyerIp ?? getBuyerIp(request, options),
    session,
    cache: options.cache,
    waitUntil: options.waitUntil,
    signal: request.signal,
    markPersonalized() {
      personalized = true;
    },
    applyResponseHeaders(headers: Headers) {
      const cookies = session.commit();
      for (const cookie of cookies) {
        headers.append("Set-Cookie", cookie);
      }

      if (cookies.length || personalized) {
        headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
      }
    },
  };
}
