import { Account, type AccountConfig } from "./auth/account";
import { LocalAuthStore } from "./auth/local-store";
import { AuthStore } from "./auth/store";
import { assertServerOnly, Client, isBrowser, type ClientOptions } from "./client";

interface BaseFactoryOptions {
  /**
   * The PocketBomb base URL.
   */
  url: string;

  /**
   * Optional `Accept-Language` (default to "en-US").
   */
  lang?: string;

  /**
   * Optional fetch implementation (default to the global `fetch`).
   */
  fetch?: ClientOptions["fetch"];

  /**
   * Whether the duplicated pending requests are auto cancelled (default to true).
   */
  autoCancellation?: boolean;
}

export type PublicClientOptions = BaseFactoryOptions & {
  /**
   * Optional auth store (default to an in-memory store).
   */
  authStore?: AuthStore;

  /**
   * Allows using a private key in a browser.
   *
   * NB! Never ship a private key to the browsers.
   */
  dangerouslyAllowBrowser?: boolean;
} & (
    | {
        /**
         * The browser-safe public API key (`pb_pk_...`).
         */
        publicKey: string;
        privateKey?: never;
        buyerIp?: never;
        buyerContext?: never;
      }
    | {
        /**
         * The server-only private API key (`pb_sk_...`).
         */
        privateKey: string;
        publicKey?: never;

        /**
         * The end-user IP (forwarded as `X-PB-Buyer-IP`), required unless
         * `buyerContext: "none"` is set (the key must allow it).
         */
        buyerIp?: string;

        /**
         * Set to "none" for the requests without end-user (e.g. background jobs).
         */
        buyerContext?: "none";
      }
  );

export interface AccountClientOptions extends BaseFactoryOptions, AccountConfig {
  /**
   * Optional auth store (default to a `LocalAuthStore` in browsers and an in-memory store elsewhere).
   */
  authStore?: AuthStore;

  /**
   * Optional public API key of the same OAuth2 client (sent with every request).
   */
  publicKey?: string;
}

/**
 * Creates a storefront client authenticated with an API key.
 *
 * - public key (browser/mobile safe): `createPublicClient({ url, publicKey })`
 * - private key (server-only): `createPublicClient({ url, privateKey, buyerIp })`
 *   or `createPublicClient({ url, privateKey, buyerContext: "none" })` for jobs.
 *
 * The key permissions are a ceiling and the collection rules always apply.
 *
 * @throws {Error} for a missing key, a private key without the buyer IP (or `buyerContext: "none"`)
 * and a private key in a browser (unless `dangerouslyAllowBrowser` is set).
 */
export function createPublicClient(options: PublicClientOptions): Client {
  const base: ClientOptions = {
    authStore: options.authStore || new AuthStore(),
    lang: options.lang,
    fetch: options.fetch,
    autoCancellation: options.autoCancellation,
  };

  if ("privateKey" in options && options.privateKey) {
    assertServerOnly("createPublicClient()", options);

    if (!options.buyerIp && options.buyerContext !== "none") {
      throw new Error(
        'createPublicClient() with a private key requires buyerIp (the end-user IP) or buyerContext: "none".',
      );
    }

    return new Client(options.url, {
      ...base,
      privateKey: options.privateKey,
      buyerIp: options.buyerIp,
      dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
    });
  }

  if ("publicKey" in options && options.publicKey) {
    return new Client(options.url, { ...base, publicKey: options.publicKey });
  }

  throw new Error("createPublicClient() requires a publicKey or a privateKey.");
}

/**
 * Attaches an OAuth2 {@link Account} to the provided client
 * (`client.account` + the refresh `authStrategy`).
 */
export function attachAccount<T extends Client>(client: T, config: AccountConfig): T {
  const account = new Account(client, config);
  client.account = account;
  client.authStrategy = account;
  client.autoRefreshThreshold = account.config.refreshThreshold;

  return client;
}

/**
 * Returns the default account auth store: a `LocalAuthStore` (shared by the browser tabs)
 * in browsers and an in-memory store elsewhere.
 */
export function defaultAccountAuthStore(collection: string, clientId: string): AuthStore {
  return isBrowser()
    ? new LocalAuthStore("pocketbomb_account_" + collection + "_" + clientId)
    : new AuthStore();
}

/**
 * Creates an account client (OAuth2 Authorization Code + PKCE with the hosted
 * login pages of an auth collection issuer).
 *
 * The OAuth2 flow is available as `client.account` (login, handleCallback, refresh, logout, ...)
 * and the access token is automatically refreshed before it expires.
 */
export function createAccountClient(options: AccountClientOptions): Client {
  const client = new Client(options.url, {
    authStore: options.authStore || defaultAccountAuthStore(options.collection, options.clientId),
    lang: options.lang,
    publicKey: options.publicKey,
    fetch: options.fetch,
    autoCancellation: options.autoCancellation,
  });

  return attachAccount(client, options);
}
