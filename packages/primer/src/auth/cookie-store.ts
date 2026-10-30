import { AuthStore, AuthRecord, AuthTokenMeta } from "./store";
import { cookieParse, cookieSerialize, SerializeOptions } from "../tools/cookie";

export interface CookieAuthStoreConfig {
  /**
   * The incoming request (its `Cookie` header is loaded) or the raw `Cookie` header value.
   */
  request?: { headers: { get(name: string): string | null } } | string | null;

  /**
   * The auth state cookie name (default to "pb_auth").
   */
  key?: string;

  /**
   * The account login flow cookie name (default to `key + "_flow"`; see {@link CookieAuthStore.set}).
   */
  flowKey?: string;

  /**
   * Optional cookie attributes merged with the defaults
   * (`Secure; HttpOnly; SameSite=Strict; Path=/`).
   */
  cookieOptions?: SerializeOptions;

  /**
   * Optional hook to encode the serialized JSON state before it is written
   * in the cookie (e.g. to sign or encrypt it, similar to the Hydrogen session).
   */
  encode?: (value: string) => string;

  /**
   * Optional hook to decode the cookie value back to the serialized JSON state
   * (return an empty string for an invalid/tampered value).
   */
  decode?: (value: string) => string;
}

/**
 * CookieAuthStore is a server-side (SSR) auth store that loads the auth state
 * from the request `Cookie` header and exports the changes as `Set-Cookie`
 * header values (similar to the Hydrogen cookie session).
 *
 * It also implements the {@link LoginSession} interface so that it could be used
 * as the `session` of an account client (the OAuth2 login flow state is stored
 * in a separate short-lived cookie between the login redirect and the callback).
 *
 * Example (generic Fetch API server handler):
 *
 * ```js
 * const store = new CookieAuthStore({ request });
 * const pb = createAccountClient({ url, collection: "users", clientId, redirectUri, session: store, authStore: store });
 *
 * // ... handle the request ...
 *
 * for (const cookie of store.commit()) {
 *     response.headers.append("Set-Cookie", cookie);
 * }
 * ```
 */
export class CookieAuthStore extends AuthStore {
  private key: string;
  private flowKey: string;
  private cookieOptions: SerializeOptions;
  private encode?: (value: string) => string;
  private decode?: (value: string) => string;
  private flowData: { [key: string]: any } = {};
  private authDirty = false;
  private flowDirty = false;
  private loading = false;

  constructor(config: CookieAuthStoreConfig = {}) {
    super();

    this.key = config.key || "pb_auth";
    this.flowKey = config.flowKey || this.key + "_flow";
    this.cookieOptions = config.cookieOptions || {};
    this.encode = config.encode;
    this.decode = config.decode;

    let rawCookie = "";
    if (typeof config.request === "string") {
      rawCookie = config.request;
    } else if (config.request?.headers) {
      rawCookie = config.request.headers.get("cookie") || "";
    }

    const cookies = cookieParse(rawCookie);

    this.loading = true;
    try {
      const raw = this.decodeValue(cookies[this.key] || "");
      if (raw) {
        // note: loadFromCookie expects a cookie string
        this.loadFromCookie(cookieSerialize(this.key, raw), this.key);
      }

      const rawFlow = this.decodeValue(cookies[this.flowKey] || "");
      if (rawFlow) {
        const parsed = JSON.parse(rawFlow);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.flowData = parsed;
        }
      }
    } catch (_) {
    } finally {
      this.loading = false;
    }
  }

  /**
   * Reports whether the auth state or the login flow state was changed
   * since the store initialization (aka. there are cookies to commit).
   */
  get isDirty(): boolean {
    return this.authDirty || this.flowDirty;
  }

  /**
   * @inheritdoc
   */
  save(token: string, record?: AuthRecord, meta?: AuthTokenMeta | null): void {
    super.save(token, record, meta);

    if (!this.loading) {
      this.authDirty = true;
    }
  }

  /**
   * @inheritdoc
   */
  clear(): void {
    super.clear();
    this.authDirty = true;
  }

  // LoginSession interface (the OAuth2 login flow state)
  // ---------------------------------------------------------------

  /**
   * Returns a login flow state value (see {@link LoginSession}).
   */
  get(key: string): any {
    return this.flowData[key];
  }

  /**
   * Stores a login flow state value (see {@link LoginSession}).
   */
  set(key: string, value: any): void {
    this.flowData[key] = value;
    this.flowDirty = true;
  }

  /**
   * Removes a login flow state value (see {@link LoginSession}).
   */
  unset(key: string): void {
    if (key in this.flowData) {
      delete this.flowData[key];
      this.flowDirty = true;
    }
  }

  // ---------------------------------------------------------------

  /**
   * Returns the `Set-Cookie` header values of the changed state
   * (an expired cookie for a cleared state).
   */
  commit(): Array<string> {
    const result: Array<string> = [];

    if (this.authDirty) {
      result.push(this.exportAuthCookie());
      this.authDirty = false;
    }

    if (this.flowDirty) {
      result.push(this.exportFlowCookie());
      this.flowDirty = false;
    }

    return result;
  }

  private exportAuthCookie(): string {
    const exported = this.exportToCookie(
      Object.assign({}, this.cookieOptions, this.token ? {} : { maxAge: 0 }),
      this.key,
    );

    if (!this.encode) {
      return exported;
    }

    // re-serialize the encoded value with the same attributes
    const value = cookieParse(exported)[this.key] || "";
    const attrs = exported.substring(exported.indexOf(";"));

    return cookieSerialize(this.key, this.encode(value)) + (attrs.startsWith(";") ? attrs : "");
  }

  private exportFlowCookie(): string {
    const isEmpty = !Object.keys(this.flowData).length;
    const value = isEmpty ? "" : JSON.stringify(this.flowData);

    return cookieSerialize(
      this.flowKey,
      value && this.encode ? this.encode(value) : value,
      Object.assign(
        {
          secure: true,
          httpOnly: true,
          // Lax so that the cookie is sent with the issuer redirect back to the app
          sameSite: "lax",
          path: "/",
        },
        this.cookieOptions,
        {
          sameSite: "lax",
          maxAge: isEmpty ? 0 : 600,
        },
      ) as SerializeOptions,
    );
  }

  private decodeValue(value: string): string {
    if (!value) {
      return "";
    }

    return this.decode ? this.decode(value) : value;
  }
}
