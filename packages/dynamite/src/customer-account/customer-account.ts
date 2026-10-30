import {
  createAccountClient,
  type Account,
  type AccountCallbackResult,
  type AccountConfig,
  type AccountLoginOptions,
  type AccountLogoutOptions,
  type AccountMe,
  type AuthStore,
  type Client,
  type GraphQLResponse,
} from "pocketbomb-primer";
import type { RequestContext } from "../core/request-context";
import {
  executeGraphQL as sendGraphQL,
  unwrapGraphQLResponse,
  type GraphQLRequestOptions,
  type ResultOf,
  type DocumentInput,
  type VariablesOf,
} from "../graphql/graphql";

export interface CustomerAccountClientOptions extends Omit<AccountConfig, "session"> {
  /**
   * The PocketBomb base URL.
   */
  url: string;

  /**
   * Optional public API key of the same OAuth2 client (sent with every request).
   */
  publicKey?: string;

  /**
   * Optional `Accept-Language` (default to "en-US").
   */
  lang?: string;

  /**
   * Optional fetch implementation.
   */
  fetch?: typeof fetch;

  /**
   * The per-request context of a server rendered app: the customer session is stored in
   * its httpOnly cookie session (auth state + login flow state) and the `*Redirect()`
   * helpers return redirect responses with the session cookies.
   */
  requestContext?: RequestContext;

  /**
   * The auth store (browser/mobile; default to the request context session for SSR,
   * a `LocalAuthStore` in browsers and an in-memory store elsewhere).
   */
  authStore?: AuthStore;

  /**
   * The login flow state storage (default to the request context session for SSR).
   */
  session?: AccountConfig["session"];
}

export interface LoginRedirectOptions extends AccountLoginOptions {
  /**
   * The app path to return to after the sign-in (stored in the login state).
   */
  returnTo?: string;
}

export interface CallbackRedirectOptions {
  /**
   * The callback URL (default to the request context request URL).
   */
  url?: string;

  /**
   * Where to redirect after a successful sign-in without a `returnTo` (default to "/").
   */
  successRedirect?: string;
}

/**
 * The customer account client (see {@link createCustomerAccountClient}).
 */
export interface CustomerAccountClient {
  /**
   * The underlying primer account client (records REST with the customer token, ...).
   */
  readonly client: Client;

  /**
   * The primer OAuth2 account (PKCE, refresh rotation, logout).
   */
  readonly account: Account;

  /** Browser redirect (or mobile `openAuthSession`) login. */
  login(options?: AccountLoginOptions): Promise<AccountCallbackResult | null>;

  /** Browser redirect (or mobile `openAuthSession`) signup (`prompt=create`). */
  signup(options?: Omit<AccountLoginOptions, "prompt">): Promise<AccountCallbackResult | null>;

  /** Handles the authorization response of the provided (or the current browser) URL. */
  handleCallback(url?: string): Promise<AccountCallbackResult | null>;

  /** Revokes the refresh token, clears the session and ends the issuer session. */
  logout(options?: AccountLogoutOptions): Promise<string>;

  /** Loosely checks whether the customer has a valid access token. */
  isLoggedIn(): boolean;

  /** Returns a valid (refreshed if needed) access token or an empty string. */
  getAccessToken(): Promise<string>;

  /** Returns the customer record and permissions (`/api/permissions/me`). */
  me(): Promise<AccountMe>;

  /** Returns the OpenID Connect userinfo claims. */
  userinfo(): Promise<{ [key: string]: any }>;

  /** Sends an email change request for the signed in customer. */
  requestEmailChange(newEmail: string): Promise<boolean>;

  /** Sends a verification email request. */
  requestVerification(email: string): Promise<boolean>;

  /** Sends a typed GraphQL document with the customer token. */
  graphql<Doc extends DocumentInput>(
    document: Doc,
    options?: GraphQLRequestOptions<VariablesOf<Doc>>,
  ): Promise<GraphQLResponse<ResultOf<Doc>>>;

  /** Like `graphql()` but returns the `data` and throws a `GraphQLError` for the GraphQL errors. */
  query<Doc extends DocumentInput>(
    document: Doc,
    options?: GraphQLRequestOptions<VariablesOf<Doc>>,
  ): Promise<ResultOf<Doc>>;

  /** SSR: returns a redirect response to the hosted login page (requires `requestContext`). */
  loginRedirect(options?: LoginRedirectOptions): Promise<Response>;

  /** SSR: handles the callback request and redirects to the `returnTo` page (requires `requestContext`). */
  callbackRedirect(options?: CallbackRedirectOptions): Promise<Response>;

  /** SSR: signs out and redirects to the issuer end_session page (requires `requestContext`). */
  logoutRedirect(options?: Omit<AccountLogoutOptions, "redirect">): Promise<Response>;
}

/**
 * Creates the customer account client of an auth collection issuer
 * (hosted login/signup with PKCE, refresh rotation, logout, own sessions and consents),
 * similar to the Hydrogen `createCustomerAccountClient`.
 *
 * - SSR: pass the `requestContext` (the session is stored in its httpOnly cookie) and use
 *   the `loginRedirect()`, `callbackRedirect()` and `logoutRedirect()` route helpers.
 * - browser: `login()` redirects and `handleCallback()` completes the sign-in.
 * - mobile: pass an `openAuthSession` adapter and an `AsyncAuthStore`.
 */
export function createCustomerAccountClient(
  options: CustomerAccountClientOptions,
): CustomerAccountClient {
  const context = options.requestContext;
  const { requestContext: _, ...rest } = options;

  const client = createAccountClient({
    ...rest,
    authStore: options.authStore || context?.session,
    session: options.session || context?.session,
    backgroundRefresh: context ? false : options.backgroundRefresh,
    // the SSR helpers build the redirect responses themselves
    navigate: options.navigate || (context ? () => {} : undefined),
    // concurrent server loaders must not cancel each other
    autoCancellation: context ? false : undefined,
  });
  const account = client.account;

  function requireContext(name: string): RequestContext {
    if (!context) {
      throw new Error(name + "() requires the requestContext option.");
    }
    return context;
  }

  function redirect(location: string, ctx: RequestContext): Response {
    const headers = new Headers({ Location: location });
    ctx.markPersonalized();
    ctx.applyResponseHeaders(headers);

    return new Response(null, { status: 302, headers });
  }

  function personalized(): void {
    if (context && client.authStore.token) {
      context.markPersonalized();
    }
  }

  async function graphql<Doc extends DocumentInput>(
    document: Doc,
    requestOptions: GraphQLRequestOptions<VariablesOf<Doc>> = {},
  ): Promise<GraphQLResponse<ResultOf<Doc>>> {
    personalized();
    return sendGraphQL(client, document, requestOptions);
  }

  return {
    client,
    account,
    login: (opts) => account.login(opts),
    signup: (opts) => account.signup(opts),
    handleCallback: (url) => account.handleCallback(url),
    logout: (opts) => account.logout(opts),
    isLoggedIn: () => account.isLoggedIn(),
    getAccessToken: () => account.getAccessToken(),
    me: () => {
      personalized();
      return account.me();
    },
    userinfo: () => {
      personalized();
      return account.userinfo();
    },
    requestEmailChange: (newEmail) =>
      client.collection(account.config.collection).requestEmailChange(newEmail),
    requestVerification: (email) =>
      client.collection(account.config.collection).requestVerification(email),
    graphql,
    async query(document, requestOptions) {
      return unwrapGraphQLResponse(await graphql(document, requestOptions));
    },
    async loginRedirect(opts = {}) {
      const ctx = requireContext("loginRedirect");
      const { returnTo, ...loginOptions } = opts;
      const state =
        returnTo !== undefined ? { ...loginOptions.state, returnTo } : loginOptions.state;

      return redirect(await account.authorizeURL({ ...loginOptions, state }), ctx);
    },
    async callbackRedirect(opts = {}) {
      const ctx = requireContext("callbackRedirect");
      const url = opts.url || ctx.request.url;
      if (!url) {
        throw new Error("callbackRedirect() requires the callback url (missing request.url).");
      }

      const result = await account.handleCallback(url);
      const returnTo = result?.state?.returnTo;

      return redirect(
        typeof returnTo === "string" && isSafeReturnTo(returnTo)
          ? returnTo
          : opts.successRedirect || "/",
        ctx,
      );
    },
    async logoutRedirect(opts = {}) {
      const ctx = requireContext("logoutRedirect");

      return redirect(await account.logout({ ...opts, redirect: true }), ctx);
    },
  };
}

/**
 * Reports whether the provided return path is a same-origin relative path
 * (prevents open redirects through the login state).
 */
export function isSafeReturnTo(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
