import type { Account } from "./auth/account";
import { AuthStore } from "./auth/store";
import { ClientResponseError } from "./errors";
import { FileService } from "./files/files";
import { RealtimeService } from "./realtime/realtime";
import { BatchService } from "./records/batch";
import { RecordService } from "./records/records";
import { HealthService } from "./services/health";
import type { RecordModel } from "./tools/dtos";
import { convertToFormDataIfNeeded, isFormData } from "./tools/formdata";
import { isTokenExpired } from "./tools/jwt";
import {
  normalizeUnknownQueryParams,
  serializeQueryParams,
  type SendOptions,
} from "./tools/options";

/**
 * The PocketBomb API key and buyer headers.
 */
export const PUBLIC_KEY_HEADER = "X-PB-Public-Key";
export const PRIVATE_KEY_HEADER = "X-PB-Private-Key";
export const BUYER_IP_HEADER = "X-PB-Buyer-IP";

/**
 * AuthStrategy defines how a client obtains a new access token
 * (used by the auto refresh before each request and the single retry on 401).
 *
 * The built-in strategy is the OAuth2 account ({@link Account}, `createAccountClient()`):
 * the refresh_token grant (rotation, cross-tab lock).
 */
export interface AuthStrategy {
  /**
   * Obtains and stores a new access token in the client auth store.
   *
   * Resolves to whether a new valid token is available
   * (it could also throw, e.g. on invalid client credentials).
   */
  refresh(): Promise<boolean>;
}

/**
 * GraphQL request options (see {@link Client.graphql}).
 */
export interface GraphQLOptions extends SendOptions {
  variables?: { [key: string]: any };
  operationName?: string;
}

/**
 * A GraphQL error of a GraphQL response.
 */
export interface GraphQLFormattedError {
  [key: string]: any;
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
  extensions?: { [key: string]: any };
}

/**
 * GraphQL response (the GraphQL errors are returned with HTTP 200).
 */
export interface GraphQLResponse<T = any> {
  data?: T | null;
  errors?: Array<GraphQLFormattedError>;
}

export interface BeforeSendResult {
  url?: string;
  options?: SendOptions;
}

export interface ClientOptions {
  /**
   * The auth store (default to an in-memory {@link AuthStore}).
   */
  authStore?: AuthStore | null;

  /**
   * The `Accept-Language` header value (default to "en-US").
   */
  lang?: string;

  /**
   * The browser-safe public API key (`pb_pk_...`), sent as `X-PB-Public-Key`
   * (and as `pk` query parameter of the realtime connection).
   */
  publicKey?: string;

  /**
   * The server-only private API key (`pb_sk_...`), sent as `X-PB-Private-Key`.
   *
   * The client throws if it is created with a private key in a browser
   * (unless `dangerouslyAllowBrowser` is set).
   */
  privateKey?: string;

  /**
   * The end-user IP forwarded with the private key requests as `X-PB-Buyer-IP`.
   */
  buyerIp?: string;

  /**
   * Allows a private key in a browser environment.
   *
   * NB! Never ship a private key or a client secret to the browsers.
   */
  dangerouslyAllowBrowser?: boolean;

  /**
   * Whether the duplicated pending requests are auto cancelled
   * (default to true; see {@link Client.autoCancellation}).
   */
  autoCancellation?: boolean;

  /**
   * Optional fetch implementation (default to the global `fetch`).
   */
  fetch?: SendOptions["fetch"];
}

/**
 * Reports whether the code runs in a browser-like environment (a global `document`).
 */
export function isBrowser(): boolean {
  return typeof document !== "undefined";
}

/**
 * Throws if a secret (private key or client secret) is used in a browser
 * environment without the explicit `dangerouslyAllowBrowser` opt-in.
 */
export function assertServerOnly(
  name: string,
  options: { dangerouslyAllowBrowser?: boolean },
): void {
  if (isBrowser() && !options.dangerouslyAllowBrowser) {
    throw new Error(
      name +
        " received a secret (private key or client secret) in a browser environment. " +
        "Secrets must never be shipped to browsers; use it only on a server " +
        "(or pass `dangerouslyAllowBrowser: true` if you know what you are doing).",
    );
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * The PocketBomb API client (the transport shared by every PocketBomb package).
 *
 * It sends the requests with the API key headers and the auth store access token,
 * normalizes the errors ({@link ClientResponseError}) and refreshes the access token
 * with the optional {@link AuthStrategy}.
 *
 * Usually it is created with a factory (`createPublicClient()`, `createAccountClient()`).
 */
export class Client {
  /**
   * The base PocketBomb backend url address (eg. 'http://127.0.0.1:8090').
   */
  baseURL: string;

  /**
   * Hook that get triggered right before sending the fetch request,
   * allowing you to inspect and modify the url and request options.
   *
   * Return a non-empty result object `{ url, options }` to replace the url and request options.
   *
   * Example:
   * ```js
   * client.beforeSend = function (url, options) {
   *     options.headers = Object.assign({}, options.headers, { "X-Custom-Header": "example" });
   *
   *     return { url, options };
   * };
   * ```
   */
  beforeSend?: (
    url: string,
    options: SendOptions,
  ) => BeforeSendResult | void | Promise<BeforeSendResult | void>;

  /**
   * Hook that get triggered after successfully sending the fetch request,
   * allowing you to inspect/modify the response object and its parsed data.
   *
   * Returns the new Promise resolved `data` that will be returned to the client.
   */
  afterSend?: (response: Response, data: any, options: SendOptions) => any;

  /**
   * The language code sent with the requests as `Accept-Language` header.
   */
  lang: string;

  /**
   * A replaceable instance of the auth store.
   */
  authStore: AuthStore;

  /**
   * An instance of the service that handles the **File APIs** (file URLs and tokens).
   */
  readonly files: FileService;

  /**
   * An instance of the service that handles the **Realtime APIs**.
   */
  readonly realtime: RealtimeService;

  /**
   * An instance of the service that handles the **Health APIs**.
   */
  readonly health: HealthService;

  /**
   * The public API key sent with every request as `X-PB-Public-Key`.
   */
  publicKey: string;

  /**
   * The private (server-only) API key sent with every request as `X-PB-Private-Key`.
   */
  privateKey: string;

  /**
   * The end-user IP forwarded with the private key requests as `X-PB-Buyer-IP`.
   */
  buyerIp: string;

  /**
   * Optional auth strategy used to refresh the access token before
   * it expires (see `autoRefreshThreshold`) and once on a 401 response.
   */
  authStrategy: AuthStrategy | null = null;

  /**
   * The number of seconds before the access token expiration when
   * the `authStrategy` refresh is triggered before a request (default to 60).
   */
  autoRefreshThreshold: number = 60;

  private accountInstance: Account | null = null;
  private cancelControllers: { [key: string]: AbortController } = {};
  private recordServices: { [key: string]: RecordService<any> } = {};
  private enableAutoCancellation: boolean;
  private fetchFunc?: SendOptions["fetch"];

  constructor(baseURL = "/", options: ClientOptions = {}) {
    if (options.privateKey) {
      assertServerOnly("Client", options);
    }

    this.baseURL = baseURL;
    this.lang = options.lang || "en-US";
    this.authStore = options.authStore || new AuthStore();
    this.publicKey = options.publicKey || "";
    this.privateKey = options.privateKey || "";
    this.buyerIp = options.buyerIp || "";
    this.enableAutoCancellation = options.autoCancellation ?? true;
    this.fetchFunc = options.fetch;

    this.files = new FileService(this);
    this.realtime = new RealtimeService(this);
    this.health = new HealthService(this);
  }

  /**
   * The OAuth2/OIDC account (login, logout, refresh, etc.) of the clients
   * created with `createAccountClient()`.
   *
   * @throws {Error} if the client is not an account client.
   */
  get account(): Account {
    if (!this.accountInstance) {
      throw new Error("The client is not an account client (use createAccountClient()).");
    }

    return this.accountInstance;
  }

  set account(account: Account) {
    this.accountInstance = account;
  }

  /**
   * Reports whether the client is an account client (see `createAccountClient()`).
   */
  get isAccountClient(): boolean {
    return !!this.accountInstance;
  }

  /**
   * Sends a GraphQL query to the read-only GraphQL API (`POST /api/graphql`).
   *
   * The GraphQL errors are returned in the result `errors` (the API responds with 200);
   * a `ClientResponseError` is thrown only for the HTTP errors (e.g. 400 invalid body,
   * 401 missing client credentials).
   *
   * Example:
   *
   * ```js
   * const { data, errors } = await client.graphql(`
   *     query Posts($first: Int) {
   *         posts(first: $first) { nodes { id title } pageInfo { hasNextPage endCursor } }
   *     }
   * `, { variables: { first: 10 } });
   * ```
   *
   * @throws {ClientResponseError}
   */
  async graphql<T = any>(query: string, options?: GraphQLOptions): Promise<GraphQLResponse<T>> {
    const { variables, operationName, ...sendOptions } = Object.assign({}, options);

    const body: { [key: string]: any } = { query };
    if (variables) {
      body.variables = variables;
    }
    if (operationName) {
      body.operationName = operationName;
    }

    return this.send(
      "/api/graphql",
      Object.assign({ requestKey: null }, sendOptions, {
        method: "POST",
        body,
      }),
    );
  }

  /**
   * Creates a new batch handler for sending multiple transactional
   * create/update/upsert/delete collection requests in one network call.
   *
   * Example:
   * ```js
   * const batch = client.createBatch();
   *
   * batch.collection("example1").create({ ... })
   * batch.collection("example2").update("RECORD_ID", { ... })
   * batch.collection("example3").delete("RECORD_ID")
   * batch.collection("example4").upsert({ ... })
   *
   * await batch.send()
   * ```
   */
  createBatch(): BatchService {
    return new BatchService(this);
  }

  /**
   * Returns the RecordService associated to the specified collection.
   */
  collection<M = RecordModel>(idOrName: string): RecordService<M> {
    if (!this.recordServices[idOrName]) {
      this.recordServices[idOrName] = new RecordService(this, idOrName);
    }

    return this.recordServices[idOrName];
  }

  /**
   * Globally enable or disable auto cancellation for pending duplicated requests.
   */
  autoCancellation(enable: boolean): this {
    this.enableAutoCancellation = !!enable;

    return this;
  }

  /**
   * Cancels single request by its cancellation key.
   */
  cancelRequest(requestKey: string): this {
    if (this.cancelControllers[requestKey]) {
      this.cancelControllers[requestKey].abort();
      delete this.cancelControllers[requestKey];
    }

    return this;
  }

  /**
   * Cancels all pending requests.
   */
  cancelAllRequests(): this {
    for (const k in this.cancelControllers) {
      this.cancelControllers[k].abort();
    }

    this.cancelControllers = {};

    return this;
  }

  /**
   * Constructs a filter expression with placeholders populated from a parameters object.
   *
   * Placeholder parameters are defined with the `{:paramName}` notation.
   *
   * The following parameter values are supported:
   *
   * - `string`
   * - `number`
   * - `boolean`
   * - `null`
   * - `undefined` (stringified as "null")
   * - `Date` object (_stringified into the PocketBomb datetime format_)
   * - everything else is converted to a string using `JSON.stringify()`
   *
   * Example:
   *
   * ```js
   * client.collection("example").getFirstListItem(client.filter(
   *    'title ~ {:title} && created >= {:created}',
   *    { title: "example", created: new Date()}
   * ))
   * ```
   */
  filter(raw: string, params?: { [key: string]: any }): string {
    if (!params) {
      return raw;
    }

    const paramsWithPlaceholders: { [key: string]: any } = {};
    for (const k in params) {
      paramsWithPlaceholders["{:" + k + "}"] = params[k];
    }

    const pattern = Object.keys(paramsWithPlaceholders).map(escapeRegExp).join("|");
    if (!pattern) {
      return raw; // no params to replace
    }

    function stringify(val: any): string {
      switch (typeof val) {
        case "boolean":
        case "number":
          return "" + val;
        case "string":
          return JSON.stringify(val);
        default: {
          if (val == null) {
            return "null";
          }

          if (val instanceof Date) {
            return JSON.stringify(val.toISOString().replace("T", " "));
          }

          const stringified = JSON.stringify(val);

          // wrap in double quotes in case of regular array, object, etc.
          if (stringified.startsWith("[") || stringified.startsWith("{")) {
            return JSON.stringify(stringified);
          }

          return stringified;
        }
      }
    }

    return raw.replace(new RegExp(pattern, "g"), (match) =>
      stringify(paramsWithPlaceholders[match]),
    );
  }

  /**
   * Builds a full client url by safely concatenating the provided path.
   */
  buildURL(path: string): string {
    let url = this.baseURL;

    // construct an absolute base url if in a browser environment
    if (
      typeof window !== "undefined" &&
      !!window.location &&
      !url.startsWith("https://") &&
      !url.startsWith("http://")
    ) {
      url = window.location.origin?.endsWith("/")
        ? window.location.origin.substring(0, window.location.origin.length - 1)
        : window.location.origin || "";

      if (!this.baseURL.startsWith("/")) {
        url += window.location.pathname || "/";
        url += url.endsWith("/") ? "" : "/";
      }

      url += this.baseURL;
    }

    // concatenate the path
    if (path) {
      url += url.endsWith("/") ? "" : "/"; // append trailing slash if missing
      url += path.startsWith("/") ? path.substring(1) : path;
    }

    return url;
  }

  /**
   * Returns the API key headers of the client
   * (`X-PB-Private-Key` + `X-PB-Buyer-IP` or `X-PB-Public-Key`).
   */
  keyHeaders(): { [key: string]: string } {
    const headers: { [key: string]: string } = {};

    // note: the public and private keys are mutually exclusive
    if (this.privateKey) {
      headers[PRIVATE_KEY_HEADER] = this.privateKey;
      if (this.buyerIp) {
        headers[BUYER_IP_HEADER] = this.buyerIp;
      }
    } else if (this.publicKey) {
      headers[PUBLIC_KEY_HEADER] = this.publicKey;
    }

    return headers;
  }

  /**
   * Sends an api http request.
   *
   * If the client has an `authStrategy` (account clients), the access token is
   * refreshed before the request when it is missing or about to expire and once
   * more on a 401 response (the request is then retried once).
   * The requests with explicit `Authorization` header or `skipAuth` are sent as they are.
   *
   * @throws {ClientResponseError}
   */
  async send<T = any>(path: string, options: SendOptions = {}): Promise<T> {
    const original: SendOptions = cloneSendOptions(options);

    const strategy = this.authStrategy;
    const managedAuth =
      !!strategy && !original.skipAuth && getHeader(original.headers, "Authorization") === null;

    let refreshed = false;
    if (managedAuth) {
      const token = this.authStore.token;
      if (!token || isTokenExpired(token, this.autoRefreshThreshold)) {
        try {
          await strategy!.refresh();
        } catch (err) {
          throw new ClientResponseError(err);
        }
        refreshed = true;
      }
    }

    try {
      return await this.sendOnce<T>(path, cloneSendOptions(original));
    } catch (err: any) {
      if (!managedAuth || refreshed || err?.status !== 401 || !this.authStore.token) {
        throw err;
      }

      let ok = false;
      try {
        ok = await strategy!.refresh();
      } catch {
        ok = false;
      }

      if (!ok) {
        throw err;
      }

      return this.sendOnce<T>(path, cloneSendOptions(original));
    }
  }

  /**
   * Sends a single api http request (without the auth strategy handling).
   */
  private async sendOnce<T = any>(path: string, options: SendOptions): Promise<T> {
    options = this.initSendOptions(path, options);

    // build url + path
    let url = this.buildURL(path);

    if (this.beforeSend) {
      const result: BeforeSendResult = Object.assign({}, await this.beforeSend(url, options));
      url = result.url || url;
      options = result.options || options;
    }

    // serialize the query parameters
    if (typeof options.query !== "undefined") {
      const query = serializeQueryParams(options.query);
      if (query) {
        url += (url.includes("?") ? "&" : "?") + query;
      }
      delete options.query;
    }

    // ensures that the json body is serialized
    if (
      getHeader(options.headers, "Content-Type") == "application/json" &&
      options.body &&
      typeof options.body !== "string"
    ) {
      options.body = JSON.stringify(options.body);
    }

    const fetchFunc = options.fetch || this.fetchFunc || fetch;

    // send the request
    return fetchFunc(url, options)
      .then(async (response) => {
        let data: any = {};

        try {
          data = await response.json();
        } catch (err: any) {
          // all api responses are expected to return json
          // with exception of the realtime events and 204
          if (options.signal?.aborted || err?.name == "AbortError" || err?.message == "Aborted") {
            throw err;
          }
        }

        if (this.afterSend) {
          data = await this.afterSend(response, data, options);
        }

        if (response.status >= 400) {
          throw new ClientResponseError({
            url: response.url,
            status: response.status,
            data: data,
          });
        }

        return data as T;
      })
      .catch((err) => {
        // wrap to normalize all errors
        throw new ClientResponseError(err);
      });
  }

  /**
   * Shallow copy the provided object and initializes the default send options
   * (headers, query params, auto cancellation).
   */
  private initSendOptions(path: string, options: SendOptions): SendOptions {
    options = Object.assign({ method: "GET" } as SendOptions, options);

    // auto convert the body to FormData, if needed
    options.body = convertToFormDataIfNeeded(options.body);

    // move unknown send options as query parameters
    normalizeUnknownQueryParams(options);

    // add the json header, if not explicitly set
    // (for FormData body the Content-Type header should be skipped since the boundary is autogenerated)
    if (getHeader(options.headers, "Content-Type") === null && !isFormData(options.body)) {
      options.headers = Object.assign({}, options.headers, {
        "Content-Type": "application/json",
      });
    }

    // add Accept-Language header, if not explicitly set
    if (getHeader(options.headers, "Accept-Language") === null) {
      options.headers = Object.assign({}, options.headers, {
        "Accept-Language": this.lang,
      });
    }

    // check if Authorization header can be added
    if (
      !options.skipAuth &&
      // has valid token
      this.authStore.token &&
      // auth header is not explicitly set
      getHeader(options.headers, "Authorization") === null
    ) {
      options.headers = Object.assign({}, options.headers, {
        Authorization: this.authStore.token,
      });
    }
    delete options.skipAuth;

    // add the API key headers, if not explicitly set
    const keyHeaders = this.keyHeaders();
    for (const name in keyHeaders) {
      if (getHeader(options.headers, name) === null) {
        options.headers = Object.assign({}, options.headers, {
          [name]: keyHeaders[name],
        });
      }
    }

    // handle auto cancellation for duplicated pending request
    if (this.enableAutoCancellation && options.requestKey !== null) {
      const requestKey = options.requestKey || (options.method || "GET") + path;

      // cancel previous pending requests
      this.cancelRequest(requestKey);

      const controller = new AbortController();
      this.cancelControllers[requestKey] = controller;
      options.signal = controller.signal;
    }
    delete options.requestKey;

    return options;
  }
}

function cloneSendOptions(options: SendOptions): SendOptions {
  return Object.assign({}, options, {
    headers: Object.assign({}, options?.headers),
  });
}

/**
 * Extracts the header with the provided name in case-insensitive manner.
 * Returns `null` if no header matching the name is found.
 */
export function getHeader(
  headers: { [key: string]: string } | undefined,
  name: string,
): string | null {
  headers = headers || {};
  name = name.toLowerCase();

  for (const key in headers) {
    if (key.toLowerCase() == name) {
      return headers[key];
    }
  }

  return null;
}
