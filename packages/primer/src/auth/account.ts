import type { AuthStrategy, Client } from "../client";
import { ClientResponseError } from "../errors";
import type { AuthRecord } from "./store";
import { RecordModel } from "../tools/dtos";
import { getTokenPayload, isTokenExpired } from "../tools/jwt";
import { withCrossTabLock } from "./locks";
import { randomString, sha256Base64URL } from "../tools/crypto";
import {
  OAuth2GrantType,
  OAuth2TokenResponse,
  expiresInToTimestamp,
  oauth2FormRequest,
  oauth2IssuerPath,
} from "./oauth2";
import { CommonOptions, SendOptions } from "../tools/options";

/**
 * LoginSession stores the short-lived OAuth2 login flow state
 * (PKCE verifier, state, nonce) between the login redirect and the callback.
 *
 * The interface is compatible with the Hydrogen session (`get`, `set`, `unset`)
 * and it is implemented by {@link CookieAuthStore} for SSR.
 * The default in browsers is `window.sessionStorage` (see {@link SessionStorageLoginSession})
 * and {@link MemoryLoginSession} elsewhere (e.g. React Native with `openAuthSession`).
 */
export interface LoginSession {
  get(key: string): any | Promise<any>;
  set(key: string, value: any): void | Promise<void>;
  unset(key: string): void | Promise<void>;
}

/**
 * An in-memory {@link LoginSession} (the state lives as long as the instance).
 */
export class MemoryLoginSession implements LoginSession {
  private data: { [key: string]: any } = {};

  get(key: string): any {
    return this.data[key];
  }

  set(key: string, value: any): void {
    this.data[key] = value;
  }

  unset(key: string): void {
    delete this.data[key];
  }
}

/**
 * The default browser {@link LoginSession} (JSON values in `window.sessionStorage`
 * with an in-memory fallback, e.g. outside of a browser).
 */
export class SessionStorageLoginSession implements LoginSession {
  private fallback = new MemoryLoginSession();

  get(key: string): any {
    const storage = this.storage();
    if (!storage) {
      return this.fallback.get(key);
    }

    try {
      return JSON.parse(storage.getItem(key) || "null") ?? undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: any): void {
    const storage = this.storage();
    if (!storage) {
      this.fallback.set(key, value);
      return;
    }

    storage.setItem(key, JSON.stringify(value));
  }

  unset(key: string): void {
    this.fallback.unset(key);
    this.storage()?.removeItem(key);
  }

  private storage(): Storage | null {
    try {
      return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
    } catch {
      return null;
    }
  }
}

/**
 * The result of an {@link OpenAuthSession} adapter
 * (compatible with the Expo `WebBrowser.openAuthSessionAsync()` result).
 */
export type OpenAuthSessionResult =
  | { type: "success"; url: string }
  | { type: "cancel" | "dismiss" | "locked" | (string & {}); url?: undefined };

/**
 * Opens the hosted OAuth2 page `url` in an in-app authentication session and resolves
 * with the final URL once the browser is redirected to `redirectUri` (mobile apps, e.g.
 * Expo `WebBrowser.openAuthSessionAsync` or `ASWebAuthenticationSession`).
 */
export type OpenAuthSession = (url: string, redirectUri: string) => Promise<OpenAuthSessionResult>;

export interface AccountConfig {
  /**
   * The issuer auth collection name (e.g. "users"; the dashboard uses "_superusers").
   */
  collection: string;

  /**
   * The OAuth2 client_id (a public PKCE client).
   */
  clientId: string;

  /**
   * The registered redirect URI where the authorization response is handled
   * (see {@link Account.handleCallback}).
   */
  redirectUri: string;

  /**
   * The registered post logout redirect URI (default to `redirectUri`).
   */
  postLogoutRedirectUri?: string;

  /**
   * The requested scopes (default to `["openid", "email"]`).
   */
  scopes?: Array<string>;

  /**
   * The login flow state storage (default to {@link SessionStorageLoginSession}
   * in browsers and {@link MemoryLoginSession} elsewhere).
   */
  session?: LoginSession;

  /**
   * The browser navigation function used by `login()` and `logout()`
   * (default to `window.location.href = url`).
   */
  navigate?: (url: string) => void;

  /**
   * The in-app authentication session adapter of the mobile apps.
   *
   * When set, `login()`/`signup()` open the hosted page with it and complete the
   * code exchange (no navigation), and `logout()` opens the end_session page with it.
   */
  openAuthSession?: OpenAuthSession;

  /**
   * The cross-tab refresh lock name (default to a name derived from the collection and client).
   */
  lockName?: string;

  /**
   * Whether to refresh the access token in the background shortly before
   * it expires (default to `true` in browsers and `false` elsewhere).
   */
  backgroundRefresh?: boolean;

  /**
   * Refresh the access token this many seconds before its expiration (default to 60).
   */
  refreshThreshold?: number;
}

export interface AccountLoginOptions {
  /**
   * OpenID Connect `prompt` ("none", "login", "consent", "select_account").
   */
  prompt?: string;

  /**
   * OpenID Connect `max_age` (in seconds).
   */
  maxAge?: number;

  /**
   * OpenID Connect `login_hint` (e.g. the user email).
   */
  loginHint?: string;

  /**
   * Optional JSON-serializable application state returned by
   * {@link Account.handleCallback} (e.g. the page to return to).
   */
  state?: any;

  /**
   * Optional scopes overriding the configured ones for this login.
   */
  scopes?: Array<string>;

  /**
   * Optional extra authorize parameters.
   */
  params?: { [key: string]: string };
}

export interface AccountCallbackResult {
  /**
   * The authenticated record (from `GET /api/permissions/me`; null if the
   * granted scopes don't allow it).
   */
  record: AuthRecord;

  /**
   * The application state passed to `login({ state })` (if any).
   */
  state: any;
}

export interface AccountLogoutOptions {
  /**
   * Navigate to the issuer end_session endpoint (RP-initiated logout; default to true).
   *
   * Without the redirect only the local state is cleared and the refresh token is revoked
   * (the issuer root SSO session survives).
   */
  redirect?: boolean;

  /**
   * Optional post logout redirect URI (default to the configured one).
   */
  postLogoutRedirectUri?: string;

  /**
   * Optional OpenID Connect logout `state`.
   */
  state?: string;
}

export interface OAuth2ConsentModel extends RecordModel {
  collectionRef: string;
  recordRef: string;
  client: string;
  scopes: Array<string>;
}

/**
 * AccountConsentService handles the remembered OAuth2 consents of the current
 * account (the `_oauth2Consents` records API; first-party tokens only).
 */
export class AccountConsents {
  constructor(readonly client: Client) {}

  /**
   * Returns the remembered consents of the current account.
   *
   * @throws {ClientResponseError}
   */
  async list(options?: CommonOptions): Promise<Array<OAuth2ConsentModel>> {
    return this.client
      .collection<OAuth2ConsentModel>("_oauth2Consents")
      .getFullList(Object.assign({ sort: "-updated" }, options));
  }

  /**
   * Revokes (deletes) the specified remembered consent.
   *
   * @throws {ClientResponseError}
   */
  async revoke(id: string, options?: CommonOptions): Promise<boolean> {
    return this.client.collection("_oauth2Consents").delete(id, options);
  }
}

/**
 * An own auth session of the account (see {@link AccountSessions}).
 */
export interface AccountSessionModel {
  id: string;

  /**
   * Whether it is a root SSO (browser) session; the others are OAuth2 client sessions.
   */
  sso: boolean;

  /**
   * The root SSO session of a client session (if any).
   */
  parent: string;

  clientId: string;
  clientName: string;

  /**
   * Whether it is the session of the current access token (or its root SSO session).
   */
  current: boolean;

  ip: string;
  userAgent: string;
  authMethods: Array<{ method: string; provider?: string; time?: string }>;
  created: string;
  lastUsedAt: string;
  expiresAt: string;
}

/**
 * AccountSessionService handles the own auth sessions of the current account
 * (`/api/collections/{collection}/sessions`; first-party tokens only).
 */
export class AccountSessions {
  constructor(
    readonly client: Client,
    readonly collection: string,
  ) {}

  /**
   * Returns the active own sessions (root SSO and client sessions).
   *
   * @throws {ClientResponseError}
   */
  async list(options?: CommonOptions): Promise<Array<AccountSessionModel>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send(this.basePath, options);
  }

  /**
   * Ends an own session (ending a root SSO session also ends its non-offline
   * client sessions, aka. a logout of that browser).
   *
   * If the ended session is the current one (`session.current` or the access token
   * session id) the local auth state is cleared.
   *
   * @throws {ClientResponseError}
   */
  async end(
    session: string | Pick<AccountSessionModel, "id" | "current">,
    options?: CommonOptions,
  ): Promise<boolean> {
    const id = typeof session === "string" ? session : session.id;
    const isCurrent =
      (typeof session !== "string" && session.current) ||
      id === getTokenPayload(this.client.authStore.token).sid;

    options = Object.assign({ method: "POST" }, options);

    await this.client.send(this.basePath + "/" + encodeURIComponent(id) + "/end", options);

    if (isCurrent) {
      if (this.client.isAccountClient) {
        this.client.account.stopRefresh();
      }
      this.client.authStore.clear();
    }

    return true;
  }

  private get basePath(): string {
    return "/api/collections/" + encodeURIComponent(this.collection) + "/sessions";
  }
}

const defaultScopes = ["openid", "email"];
const refreshRequestTimeout = 10000; // ms

/**
 * The resolved RBAC permissions of the current actor (`GET /api/permissions/me`).
 */
export interface AccountMe {
  [key: string]: any;

  /**
   * "customer" for the records of the regular auth collections and "staff" for the superusers.
   */
  kind: string;
  owner: boolean;
  record: AuthRecord;
}

/**
 * Account is the OAuth2/OIDC (Authorization Code + PKCE) client of
 * a PocketBomb auth collection issuer (the only PocketBomb auth system).
 *
 * - `login()`: redirects to the issuer hosted login (PKCE S256, state, nonce)
 *    or opens it with the `openAuthSession` adapter (mobile)
 * - `handleCallback()`: exchanges the authorization response for tokens
 *    (the access token, refresh token and record are stored in `client.authStore`)
 * - `refresh()`: the refresh_token grant (rotation); the refreshes are serialized across
 *    the browser tabs (navigator.locks with a localStorage lease fallback) and a tab that
 *    waited for the lock reuses the tokens refreshed by another tab instead of refreshing again
 * - `logout()`: revokes the refresh token and ends the issuer session (RP-initiated logout)
 *
 * It is created by `createAccountClient()` (available as `client.account`) and it is also the
 * client `authStrategy` (auto refresh before the token expires and once on 401).
 */
export class Account implements AuthStrategy {
  readonly config: Readonly<
    Required<Omit<AccountConfig, "postLogoutRedirectUri" | "navigate" | "openAuthSession">> &
      Pick<AccountConfig, "postLogoutRedirectUri" | "navigate" | "openAuthSession">
  >;

  /**
   * The remembered OAuth2 consents of the current account.
   */
  readonly consents: AccountConsents;

  /**
   * The own auth sessions of the current account.
   */
  readonly sessions: AccountSessions;

  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: any = null;
  private authorizeRedirecting = false;
  private loggingOut = false;

  constructor(
    readonly client: Client,
    config: AccountConfig,
  ) {
    if (!config?.collection || !config?.clientId || !config?.redirectUri) {
      throw new Error("The account collection, clientId and redirectUri are required.");
    }

    this.config = Object.freeze({
      collection: config.collection,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      postLogoutRedirectUri: config.postLogoutRedirectUri,
      scopes: config.scopes?.length ? config.scopes.slice() : defaultScopes.slice(),
      session:
        config.session ||
        (typeof window !== "undefined" && !!window.document
          ? new SessionStorageLoginSession()
          : new MemoryLoginSession()),
      navigate: config.navigate,
      openAuthSession: config.openAuthSession,
      lockName:
        config.lockName || "__pb_oauth2_refresh__" + config.collection + "_" + config.clientId,
      backgroundRefresh:
        config.backgroundRefresh ?? (typeof window !== "undefined" && !!window.document),
      refreshThreshold: config.refreshThreshold ?? 60,
    });

    this.consents = new AccountConsents(client);
    this.sessions = new AccountSessions(client, config.collection);
  }

  /**
   * The issuer path (e.g. "/oauth2/users").
   */
  get issuerPath(): string {
    return oauth2IssuerPath(this.config.collection);
  }

  /**
   * The issuer URL (e.g. "https://example.com/oauth2/users").
   */
  get issuerURL(): string {
    return this.client.buildURL(this.issuerPath);
  }

  private get flowKey(): string {
    return "__pb_oauth2_flow__" + this.config.collection + "_" + this.config.clientId;
  }

  private get postLogoutKey(): string {
    return "__pb_oauth2_post_logout__" + this.config.collection + "_" + this.config.clientId;
  }

  /**
   * Reports whether the logout flow is in progress (e.g. to avoid
   * starting a new login while the issuer logout navigation is pending).
   */
  isLoggingOut(): boolean {
    return this.loggingOut;
  }

  /**
   * Loosely checks whether the account has a valid (unexpired) access token.
   */
  isLoggedIn(): boolean {
    return this.client.authStore.isValid;
  }

  /**
   * Returns a valid access token (refreshed if it is about to expire)
   * or an empty string if the account is not logged in.
   */
  async getAccessToken(): Promise<string> {
    const store = this.client.authStore;
    if (store.token && isTokenExpired(store.token, this.config.refreshThreshold)) {
      await this.refresh();
    }

    return store.isValid ? store.token : "";
  }

  // Login
  // ---------------------------------------------------------------

  /**
   * Generates a new authorization request URL and stores the login flow
   * state (PKCE verifier, state, nonce) in the account session.
   *
   * Use it directly for server-side (SSR) redirects; in browsers `login()` navigates to it.
   */
  async authorizeURL(options: AccountLoginOptions = {}): Promise<string> {
    const session = this.config.session;

    const verifier = randomString(64);
    const state = randomString(32);
    const nonce = randomString(32);

    // after a logout always ask for the credentials again, even if a root SSO
    // session survived (e.g. due to a race with an in-flight authorize request)
    let prompt = options.prompt;
    if (!prompt && (await session.get(this.postLogoutKey))) {
      prompt = "login";
      await session.unset(this.postLogoutKey);
    }

    await session.set(this.flowKey, {
      verifier,
      state,
      nonce,
      redirectUri: this.config.redirectUri,
      appState: options.state ?? null,
    });

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: (options.scopes?.length ? options.scopes : this.config.scopes).join(" "),
      state: state,
      nonce: nonce,
      code_challenge: await sha256Base64URL(verifier),
      code_challenge_method: "S256",
    });

    if (prompt) {
      params.set("prompt", prompt);
    }
    if (typeof options.maxAge === "number") {
      params.set("max_age", String(options.maxAge));
    }
    if (options.loginHint) {
      params.set("login_hint", options.loginHint);
    }
    for (const key in options.params || {}) {
      params.set(key, options.params![key]);
    }

    return this.client.buildURL(this.issuerPath + "/authorize") + "?" + params.toString();
  }

  /**
   * Starts the login by redirecting the browser to the issuer hosted login page.
   *
   * Concurrent calls (and calls during logout) are ignored so that only
   * a single authorize navigation is started.
   *
   * With the `openAuthSession` adapter (mobile) the hosted page is opened in an in-app
   * authentication session and the authorization response is handled directly:
   * it resolves with the callback result or `null` if the session was cancelled.
   * In browsers it resolves with `null` (the page navigates away).
   *
   * @throws {ClientResponseError} for an error authorization response or a failed code exchange
   * (`openAuthSession` only).
   */
  async login(options: AccountLoginOptions = {}): Promise<AccountCallbackResult | null> {
    if (this.loggingOut || this.authorizeRedirecting) {
      return null;
    }
    this.authorizeRedirecting = true;

    if (this.config.openAuthSession) {
      try {
        const result = await this.config.openAuthSession(
          await this.authorizeURL(options),
          this.config.redirectUri,
        );
        if (result.type !== "success" || !result.url) {
          await this.config.session.unset(this.flowKey);
          return null;
        }

        return await this.handleCallback(result.url);
      } finally {
        this.authorizeRedirecting = false;
      }
    }

    try {
      this.navigate(await this.authorizeURL(options));
    } catch (err) {
      this.authorizeRedirecting = false;
      throw err;
    }

    // in case the navigation is canceled (e.g. bfcache restore) allow a new login attempt
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("pageshow", () => (this.authorizeRedirecting = false), {
        once: true,
      });
    }

    return null;
  }

  /**
   * Generates an authorization request URL that opens the hosted signup page
   * (OpenID Connect `prompt=create`) and stores the login flow state.
   *
   * After the signup the flow continues like after a login (the same `handleCallback()`).
   * The issuer supports it only if its hosted signup is allowed
   * (`prompt_values_supported` of the issuer discovery), otherwise the callback
   * receives an `invalid_request` error.
   */
  async signupURL(options: Omit<AccountLoginOptions, "prompt"> = {}): Promise<string> {
    return this.authorizeURL(Object.assign({}, options, { prompt: "create" }));
  }

  /**
   * Starts the signup by redirecting the browser to the issuer hosted signup page
   * (see `signupURL()`; the same single navigation guard as `login()`).
   */
  async signup(
    options: Omit<AccountLoginOptions, "prompt"> = {},
  ): Promise<AccountCallbackResult | null> {
    return this.login(Object.assign({}, options, { prompt: "create" }));
  }

  /**
   * Reports whether the provided URL carries an authorization response (`code` or `error`).
   */
  isCallbackURL(url?: string): boolean {
    const query = this.callbackQuery(url);

    return !!query && (query.has("code") || query.has("error"));
  }

  /**
   * Handles the authorization response of the provided URL
   * (default to the current browser URL).
   *
   * Returns `null` if the URL doesn't have an authorization response. On success the
   * tokens and the record are stored in `client.authStore` and the `login({ state })` application
   * state is returned. The login flow state is always consumed (single use).
   *
   * Note that it doesn't change the browser URL (remove the query parameters yourself).
   *
   * @throws {ClientResponseError} for an error response, invalid state/nonce or a failed code exchange.
   */
  async handleCallback(url?: string): Promise<AccountCallbackResult | null> {
    const query = this.callbackQuery(url);

    const code = query?.get("code");
    const error = query?.get("error");
    if (!query || (!code && !error)) {
      return null;
    }

    const session = this.config.session;
    const flow = (await session.get(this.flowKey)) || {};
    await session.unset(this.flowKey);

    if (error) {
      throw oauth2Error(error, query.get("error_description") || "");
    }

    if (!flow.state || query.get("state") !== flow.state) {
      throw oauth2Error("invalid_state", "Invalid or expired sign-in state. Please try again.");
    }

    const tokens = await oauth2FormRequest<OAuth2TokenResponse>(
      this.client,
      this.issuerPath + "/token",
      {
        grant_type: OAuth2GrantType.authorizationCode,
        code: code,
        redirect_uri: flow.redirectUri || this.config.redirectUri,
        code_verifier: flow.verifier,
      },
      { clientId: this.config.clientId },
    );

    if (
      (tokens.id_token || this.config.scopes.includes("openid")) &&
      getTokenPayload(tokens.id_token || "").nonce !== flow.nonce
    ) {
      throw oauth2Error("invalid_nonce", "Invalid id_token nonce.");
    }

    await this.storeTokens(tokens);

    return { record: this.client.authStore.record, state: flow.appState ?? null };
  }

  // Refresh
  // ---------------------------------------------------------------

  /**
   * Refreshes the access token with the refresh_token grant.
   *
   * Concurrent calls of the same tab share the same request and the refreshes are
   * serialized across the browser tabs. After acquiring the cross-tab lock the stored
   * tokens are reloaded and if another tab has already refreshed them they are used
   * instead of refreshing again.
   *
   * An invalid or reused refresh token is removed from the auth store.
   *
   * @return Whether the refresh was successful (it never throws).
   */
  refresh(): Promise<boolean> {
    if (this.loggingOut) {
      return Promise.resolve(false);
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // the refresh token at the time of the refresh request
    const staleRefreshToken = this.client.authStore.refreshToken;
    if (!staleRefreshToken) {
      return Promise.resolve(false);
    }

    this.refreshPromise = withCrossTabLock(this.config.lockName, () =>
      this.refreshWithLock(staleRefreshToken),
    ).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async refreshWithLock(staleRefreshToken: string): Promise<boolean> {
    if (this.loggingOut) {
      return false;
    }

    // another tab refreshed while waiting for the lock
    if (this.refreshedByAnotherTab(staleRefreshToken)) {
      this.scheduleRefresh();
      return true;
    }

    const refreshToken = this.client.authStore.refreshToken;
    if (!refreshToken) {
      return false;
    }

    try {
      const tokens = await oauth2FormRequest<OAuth2TokenResponse>(
        this.client,
        this.issuerPath + "/token",
        {
          grant_type: OAuth2GrantType.refreshToken,
          refresh_token: refreshToken,
        },
        { clientId: this.config.clientId },
        { signal: (AbortSignal as any).timeout?.(refreshRequestTimeout) },
      );

      await this.storeTokens(tokens);

      return true;
    } catch (err: any) {
      // e.g. another tab (without the lock support) rotated the refresh token concurrently
      if (this.refreshedByAnotherTab(refreshToken)) {
        this.scheduleRefresh();
        return true;
      }

      // invalid or reused refresh token
      const store = this.client.authStore;
      if ((err?.status == 400 || err?.status == 401) && store.refreshToken === refreshToken) {
        const meta = store.meta;
        delete meta.refreshToken;
        delete meta.idToken;
        store.save(store.token, store.record, meta);
      }

      return false;
    }
  }

  /**
   * Reports whether another tab has already refreshed the tokens since the provided
   * refresh token was loaded (aka. the stored refresh token was rotated and the stored
   * access token is still valid).
   */
  private refreshedByAnotherTab(staleRefreshToken: string): boolean {
    const store = this.client.authStore;
    const refreshToken = store.refreshToken;
    const token = store.token;

    return (
      !!refreshToken && refreshToken !== staleRefreshToken && !!token && !isTokenExpired(token)
    );
  }

  /**
   * Schedules a background refresh shortly before the current access token expiration
   * (no-op if `backgroundRefresh` is disabled or there is no refresh token).
   *
   * If the background refresh fails, the auth store is cleared.
   */
  scheduleRefresh(): void {
    if (this.loggingOut || !this.config.backgroundRefresh) {
      return;
    }

    clearTimeout(this.refreshTimer);

    const store = this.client.authStore;
    const token = store.token;
    if (!token || !store.refreshToken) {
      return;
    }

    const threshold = this.config.refreshThreshold;
    const exp = getTokenPayload(token).exp || store.expiresAt || 0;
    const delay = Math.max(0, (exp - threshold) * 1000 - Date.now());

    this.refreshTimer = setTimeout(
      async () => {
        // the shared token was already refreshed by another tab -> reschedule
        const current = store.token;
        if (current && current !== token && !isTokenExpired(current, threshold)) {
          this.scheduleRefresh();
          return;
        }

        const ok = await this.refresh();
        if (!ok) {
          store.clear();
        }
      },
      Math.min(delay, 2147483647),
    );
  }

  /**
   * Stops the background refresh timer (if any).
   */
  stopRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Restores the stored session after a page load: an expired access token is refreshed
   * (and the auth store is cleared if that fails), otherwise the background refresh is scheduled.
   *
   * @return Whether there is a valid session.
   */
  async restore(): Promise<boolean> {
    const store = this.client.authStore;

    if (store.token && !store.isValid) {
      if (!(await this.refresh())) {
        store.clear();
        return false;
      }
      return true;
    }

    this.scheduleRefresh();

    return store.isValid;
  }

  // Logout
  // ---------------------------------------------------------------

  /**
   * Returns the issuer end_session (RP-initiated logout) URL.
   */
  logoutURL(
    options: {
      idTokenHint?: string;
      postLogoutRedirectUri?: string;
      state?: string;
    } = {},
  ): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri:
        options.postLogoutRedirectUri ||
        this.config.postLogoutRedirectUri ||
        this.config.redirectUri,
    });

    if (options.idTokenHint) {
      params.set("id_token_hint", options.idTokenHint);
    }
    if (options.state) {
      params.set("state", options.state);
    }

    return this.client.buildURL(this.issuerPath + "/logout") + "?" + params.toString();
  }

  /**
   * Signs out the account: revokes the refresh token, clears the auth store and
   * (by default) navigates to the issuer end_session endpoint with the `id_token_hint`.
   *
   * While the logout is in progress the login, refresh and token storage are disabled
   * (see `isLoggingOut()`) so that an in-flight request can't sign the user back in,
   * and the next login asks for the credentials again (`prompt=login`).
   *
   * @return The issuer logout URL.
   */
  async logout(options: AccountLogoutOptions = {}): Promise<string> {
    const store = this.client.authStore;

    if (this.loggingOut) {
      return "";
    }
    this.loggingOut = true;

    this.stopRefresh();

    // ensure the next login doesn't reuse a root SSO session
    await this.config.session.set(this.postLogoutKey, "1");

    const refreshToken = store.refreshToken;
    const idToken = store.idToken;

    if (refreshToken) {
      try {
        await oauth2FormRequest(
          this.client,
          this.issuerPath + "/revoke",
          { token: refreshToken, token_type_hint: "refresh_token" },
          { clientId: this.config.clientId },
        );
      } catch (err) {
        console.warn("Failed to revoke the refresh token:", err);
      }
    }

    store.clear();

    const url = this.logoutURL({
      idTokenHint: idToken,
      postLogoutRedirectUri: options.postLogoutRedirectUri,
      state: options.state,
    });

    if (options.redirect === false) {
      this.loggingOut = false;
    } else if (this.config.openAuthSession) {
      try {
        await this.config.openAuthSession(
          url,
          options.postLogoutRedirectUri ||
            this.config.postLogoutRedirectUri ||
            this.config.redirectUri,
        );
      } finally {
        this.loggingOut = false;
      }
    } else {
      this.navigate(url);
    }

    return url;
  }

  // Other
  // ---------------------------------------------------------------

  /**
   * Returns the OpenID Connect userinfo claims of the current account.
   *
   * @throws {ClientResponseError}
   */
  async userinfo(options?: SendOptions): Promise<{ [key: string]: any }> {
    options = Object.assign({ method: "GET", requestKey: null }, options);

    return this.client.send(this.issuerPath + "/userinfo", options);
  }

  /**
   * Returns the hosted password reset page URL.
   */
  passwordResetURL(): string {
    return this.client.buildURL(this.issuerPath + "/password-reset");
  }

  /**
   * Returns the hosted "request a new verification email" page URL.
   */
  verifyEmailURL(): string {
    return this.client.buildURL(this.issuerPath + "/verify-email/request");
  }

  /**
   * Returns the resolved RBAC permissions and the record of the current account
   * (`GET /api/permissions/me`).
   *
   * @throws {ClientResponseError}
   */
  async me(options?: SendOptions): Promise<AccountMe> {
    options = Object.assign({ method: "GET", requestKey: null }, options);

    return this.client.send("/api/permissions/me", options);
  }

  /**
   * Stores the token response and the record of the new access token in the auth store.
   */
  private async storeTokens(tokens: OAuth2TokenResponse): Promise<void> {
    if (this.loggingOut) {
      return;
    }

    // load the actor own record with the new token
    const me = await this.me({
      headers: { Authorization: tokens.access_token },
    });

    const record = me?.record || null;
    if (
      record &&
      record.collectionName != this.config.collection &&
      record.collectionId != this.config.collection
    ) {
      throw oauth2Error("invalid_record", "The token record is not from the expected collection.");
    }

    // the user could have started the logout while the record was loading
    if (this.loggingOut) {
      return;
    }

    const store = this.client.authStore;
    const previous = store.meta;

    store.save(tokens.access_token, record, {
      refreshToken: tokens.refresh_token || previous.refreshToken || "",
      idToken: tokens.id_token || previous.idToken || "",
      scope: tokens.scope,
      clientId: this.config.clientId,
      expiresAt: expiresInToTimestamp(tokens.expires_in),
    });

    this.scheduleRefresh();
  }

  private navigate(url: string): void {
    if (this.config.navigate) {
      this.config.navigate(url);
      return;
    }

    if (typeof window === "undefined" || !window.location) {
      throw new Error(
        "Not in a browser context - use authorizeURL()/logoutURL(), pass a custom navigate function or an openAuthSession adapter.",
      );
    }

    window.location.href = url;
  }

  private callbackQuery(url?: string): URLSearchParams | null {
    if (!url) {
      if (typeof window === "undefined" || !window.location) {
        return null;
      }
      url = window.location.href;
    }

    try {
      return new URL(url, "http://localhost").searchParams;
    } catch (_) {
      return null;
    }
  }
}

export function oauth2Error(code: string, description: string): ClientResponseError {
  return new ClientResponseError({
    status: 400,
    response: { error: code, error_description: description },
  });
}
