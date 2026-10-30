import {
  AuthStore,
  Client,
  BUYER_IP_HEADER,
  createPublicClient,
  PRIVATE_KEY_HEADER,
  PUBLIC_KEY_HEADER,
  type GraphQLResponse,
  type RecordModel,
  type RecordService,
} from "pocketbomb-primer";
import {
  Cache,
  sha256Hex,
  withCache,
  type CacheStore,
  type CachingStrategy,
  type WaitUntil,
} from "../core/cache";
import type { RequestContext } from "../core/request-context";
import {
  documentText,
  executeGraphQL as sendGraphQL,
  unwrapGraphQLResponse,
  type GraphQLRequestOptions,
  type ResultOf,
  type DocumentInput,
  type VariablesOf,
} from "../graphql/graphql";

interface StorefrontBaseOptions {
  /**
   * The PocketBomb base URL.
   */
  url: string;

  /**
   * Optional `Accept-Language` (default to "en-US").
   */
  lang?: string;

  /**
   * Optional fetch implementation.
   */
  fetch?: typeof fetch;

  /**
   * The per-request context (buyer IP, cache, waitUntil) of a server rendered app.
   */
  requestContext?: RequestContext;

  /**
   * The cache store of the queries (default to the request context one).
   */
  cache?: CacheStore;

  /**
   * The default caching strategy of the queries (default to `Cache.short()` when
   * a cache store is available).
   */
  defaultCache?: CachingStrategy;

  /**
   * The background work scheduler (default to the request context one).
   */
  waitUntil?: WaitUntil;
}

export type StorefrontClientOptions = StorefrontBaseOptions &
  (
    | {
        /**
         * The browser/mobile-safe public API key (`pb_pk_...`).
         */
        publicKey: string;
        privateKey?: never;
        buyerIp?: never;
        buyerContext?: never;
        dangerouslyAllowBrowser?: never;
      }
    | {
        /**
         * The server-only private API key (`pb_sk_...`).
         */
        privateKey: string;
        publicKey?: never;

        /**
         * The end-user IP (default to the request context one).
         */
        buyerIp?: string;

        /**
         * "none" for the requests without end-user (e.g. background jobs).
         */
        buyerContext?: "none";

        /**
         * Allows the private key in a browser. NB! Never ship a private key to the browsers.
         */
        dangerouslyAllowBrowser?: boolean;
      }
  );

export interface StorefrontQueryOptions<Variables> extends GraphQLRequestOptions<Variables> {
  /**
   * The caching strategy of the query (default to the client `defaultCache`).
   */
  cache?: CachingStrategy;
}

/**
 * The storefront client (see {@link createStorefrontClient}).
 */
export interface StorefrontClient {
  /**
   * The underlying primer client (records REST, files, realtime, ...).
   */
  readonly client: Client;

  /**
   * Sends a typed GraphQL document and returns the GraphQL response (`{ data, errors }`).
   * The successful responses are cached with the query caching strategy.
   */
  graphql<Doc extends DocumentInput>(
    document: Doc,
    options?: StorefrontQueryOptions<VariablesOf<Doc>>,
  ): Promise<GraphQLResponse<ResultOf<Doc>>>;

  /**
   * Like `graphql()` but returns the `data` and throws a `GraphQLError` for the GraphQL errors.
   */
  query<Doc extends DocumentInput>(
    document: Doc,
    options?: StorefrontQueryOptions<VariablesOf<Doc>>,
  ): Promise<ResultOf<Doc>>;

  /**
   * The records REST API of a collection.
   */
  collection<M = RecordModel>(idOrName: string): RecordService<M>;

  /**
   * Returns the absolute URL of a record file.
   */
  getFileURL(
    record: { [key: string]: any },
    filename: string,
    query?: { [key: string]: any },
  ): string;

  /**
   * Returns the absolute API URL of the provided path (e.g. "/api/graphql").
   */
  getApiURL(path?: string): string;

  /**
   * Returns the browser-safe headers of a public key client (`X-PB-Public-Key`;
   * empty for a private key client).
   */
  getPublicHeaders(): { [key: string]: string };

  /**
   * Sends a request through the application proxy of the instance
   * (e.g. `storefront.appProxy("/apps/reviews/widget?product=1")`) with the client API key.
   */
  appProxy(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * Creates a storefront client (public key for browsers/mobile, private key + buyer IP for servers),
 * similar to the Hydrogen `createStorefrontClient`.
 *
 * ```ts
 * // server (loader)
 * const storefront = createStorefrontClient({ url, privateKey, requestContext });
 * const { articles } = await storefront.query(ARTICLES, { variables: { first: 10 } });
 *
 * // browser / mobile
 * const storefront = createStorefrontClient({ url, publicKey });
 * ```
 *
 * @throws {Error} for a missing key, a private key without the buyer IP
 * (or `buyerContext: "none"`) and a private key in a browser.
 */
export function createStorefrontClient(options: StorefrontClientOptions): StorefrontClient {
  const context = options.requestContext;

  const client =
    "privateKey" in options && options.privateKey
      ? createPublicClient({
          url: options.url,
          lang: options.lang,
          fetch: options.fetch,
          privateKey: options.privateKey,
          buyerIp: options.buyerIp || context?.buyerIp || undefined,
          buyerContext: options.buyerContext,
          dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
          authStore: new AuthStore(),
          // concurrent server loaders must not cancel each other
          autoCancellation: false,
        })
      : createPublicClient({
          url: options.url,
          lang: options.lang,
          fetch: options.fetch,
          publicKey: (options as { publicKey: string }).publicKey,
          authStore: new AuthStore(),
          autoCancellation: false,
        });

  const cache = options.cache || context?.cache;
  const waitUntil = options.waitUntil || context?.waitUntil;
  const defaultCache = options.defaultCache || (cache ? Cache.short() : Cache.none());

  // the cache entries are scoped by the API key (hashed) and the base URL
  const keyScope = sha256Hex(options.url + "\n" + (client.privateKey || client.publicKey));

  async function graphql<Doc extends DocumentInput>(
    document: Doc,
    queryOptions: StorefrontQueryOptions<VariablesOf<Doc>> = {},
  ): Promise<GraphQLResponse<ResultOf<Doc>>> {
    const { cache: strategy, ...requestOptions } = queryOptions;
    if (!requestOptions.signal && context?.signal) {
      requestOptions.signal = context.signal;
    }

    const key =
      "pocketbomb:graphql:" +
      (await keyScope) +
      ":" +
      (await sha256Hex(
        JSON.stringify([
          documentText(document),
          requestOptions.variables || null,
          requestOptions.operationName || null,
        ]),
      ));

    return withCache(
      {
        cache,
        key,
        strategy: strategy || defaultCache,
        waitUntil,
        shouldCache: (response: GraphQLResponse) => !response?.errors?.length,
      },
      () => sendGraphQL(client, document, requestOptions),
    );
  }

  return {
    client,
    graphql,
    async query(document, queryOptions) {
      return unwrapGraphQLResponse(await graphql(document, queryOptions));
    },
    collection(idOrName) {
      return client.collection(idOrName);
    },
    getFileURL(record, filename, query = {}) {
      return client.files.getURL(record, filename, query);
    },
    getApiURL(path = "") {
      return client.buildURL(path);
    },
    getPublicHeaders() {
      const headers: { [key: string]: string } = {};
      if (!client.privateKey && client.publicKey) {
        headers[PUBLIC_KEY_HEADER] = client.publicKey;
      }
      return headers;
    },
    appProxy(path, init = {}) {
      const headers = new Headers(init.headers);
      if (client.privateKey) {
        headers.set(PRIVATE_KEY_HEADER, client.privateKey);
        if (client.buyerIp) {
          headers.set(BUYER_IP_HEADER, client.buyerIp);
        }
      } else if (client.publicKey) {
        headers.set(PUBLIC_KEY_HEADER, client.publicKey);
      }

      return (options.fetch || fetch)(client.buildURL(path), { ...init, headers });
    },
  };
}
