import { cookieParse, cookieSerialize, SerializeOptions } from "../tools/cookie";
import { isTokenExpired, getTokenPayload } from "../tools/jwt";
import { RecordModel } from "../tools/dtos";

export type AuthRecord = RecordModel | null;

export type OnStoreChangeFunc = (token: string, record: AuthRecord) => void;

/**
 * The OAuth2 metadata of the stored access token.
 */
export interface AuthTokenMeta {
  [key: string]: any;

  /**
   * The OAuth2 refresh token (account clients only; rotated on every refresh).
   */
  refreshToken?: string;

  /**
   * The OpenID Connect id_token (used as `id_token_hint` on logout).
   */
  idToken?: string;

  /**
   * The access token expiration as unix timestamp in seconds.
   */
  expiresAt?: number;

  /**
   * The space separated granted scopes.
   */
  scope?: string;

  /**
   * The OAuth2 client_id the access token was issued to.
   */
  clientId?: string;

  /**
   * The staff member of an application extension online token (`{id, roles}`).
   */
  associatedUser?: { id: string; roles: Array<string> };
}

/**
 * The OAuth2 metadata keys persisted next to the token and record.
 */
export const authTokenMetaKeys = [
  "refreshToken",
  "idToken",
  "expiresAt",
  "scope",
  "clientId",
  "associatedUser",
];

/**
 * Extracts the known non-empty OAuth2 metadata keys from the provided raw data object.
 */
export function extractAuthTokenMeta(
  data: { [key: string]: any } | null | undefined,
): AuthTokenMeta {
  const result: AuthTokenMeta = {};

  if (!data || typeof data !== "object") {
    return result;
  }

  for (const key of authTokenMetaKeys) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
      result[key] = data[key];
    }
  }

  return result;
}

const defaultCookieKey = "pb_auth";

/**
 * AuthStore is the base auth store class and the in-memory auth store
 * (the state lives only for the duration of the store instance).
 *
 * The other built-in stores extend it: {@link LocalAuthStore} (browser localStorage),
 * {@link AsyncAuthStore} (AsyncStorage-like async key-value storages, e.g. React Native)
 * and {@link CookieAuthStore} (SSR cookie session).
 */
export class AuthStore {
  protected baseToken: string = "";
  protected baseModel: AuthRecord = null;
  protected baseMeta: AuthTokenMeta = {};

  private _onChangeCallbacks: Array<OnStoreChangeFunc> = [];

  /**
   * Retrieves the stored token (if any).
   */
  get token(): string {
    return this.baseToken;
  }

  /**
   * Retrieves the stored model data (if any).
   */
  get record(): AuthRecord {
    return this.baseModel;
  }

  /**
   * Retrieves a copy of the stored OAuth2 token metadata (refresh token, id_token, etc.).
   */
  get meta(): AuthTokenMeta {
    return Object.assign({}, this.baseMeta);
  }

  /**
   * Alias of `token` (the stored OAuth2 access token).
   */
  get accessToken(): string {
    return this.token;
  }

  /**
   * Retrieves the stored OAuth2 refresh token (if any).
   */
  get refreshToken(): string {
    return this.meta.refreshToken || "";
  }

  /**
   * Retrieves the stored OpenID Connect id_token (if any).
   */
  get idToken(): string {
    return this.meta.idToken || "";
  }

  /**
   * Retrieves the access token expiration as unix timestamp in seconds
   * (from the stored metadata or the token `exp` claim; 0 if unknown).
   */
  get expiresAt(): number {
    return this.meta.expiresAt || getTokenPayload(this.token).exp || 0;
  }

  /**
   * Retrieves the space separated granted scopes
   * (from the stored metadata or the token `scope` claim).
   */
  get scope(): string {
    return this.meta.scope || getTokenPayload(this.token).scope || "";
  }

  /**
   * Retrieves the OAuth2 client_id of the access token
   * (from the stored metadata or the token `cid` claim).
   */
  get clientId(): string {
    return this.meta.clientId || getTokenPayload(this.token).cid || "";
  }

  /**
   * Loosely checks if the store has valid token (aka. existing and unexpired exp claim
   * and stored `expiresAt`).
   */
  get isValid(): boolean {
    const metaExp = this.meta.expiresAt;
    if (metaExp && metaExp <= Date.now() / 1000) {
      return false;
    }

    return !isTokenExpired(this.token);
  }

  /**
   * Loosely checks whether the currently loaded store state is for superuser.
   *
   * Alternatively you can also compare directly `pb.authStore.record?.collectionName`.
   */
  get isSuperuser(): boolean {
    let payload = getTokenPayload(this.token);

    return (
      payload.type == "auth" &&
      (this.record?.collectionName == "_superusers" ||
        // fallback in case the record field is not populated and assuming
        // that the collection crc32 checksum id wasn't manually changed
        (!this.record?.collectionName && payload.collectionId == "pbc_3142635823"))
    );
  }

  /**
   * Saves the provided new token and model data in the auth store.
   *
   * If `meta` is not provided (`undefined`) the current OAuth2 token
   * metadata is kept (e.g. when only the record is updated).
   * Pass `null` or `{}` to clear it.
   */
  save(token: string, record?: AuthRecord, meta?: AuthTokenMeta | null): void {
    this.baseToken = token || "";
    this.baseModel = record || null;
    if (meta !== undefined) {
      this.baseMeta = extractAuthTokenMeta(meta);
    }

    this.triggerChange();
  }

  /**
   * Removes the stored token, model data and OAuth2 metadata from the auth store.
   */
  clear(): void {
    this.baseToken = "";
    this.baseModel = null;
    this.baseMeta = {};
    this.triggerChange();
  }

  /**
   * Parses the provided cookie string and updates the store state
   * with the cookie's token and model data.
   *
   * NB! This function doesn't validate the token or its data.
   * Usually this isn't a concern if you are interacting only with the
   * PocketBomb API because it has the proper server-side security checks in place,
   * but if you are using the store `isValid` state for permission controls
   * in a node server (eg. SSR), then it is recommended to verify the loaded
   * state with the server (e.g. `await pb.account.refresh()` or `pb.roles.me()`).
   *
   * See also {@link CookieAuthStore}.
   */
  loadFromCookie(cookie: string, key = defaultCookieKey): void {
    const rawData = cookieParse(cookie || "")[key] || "";

    let data: { [key: string]: any } = {};
    try {
      data = JSON.parse(rawData);
      // normalize
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        data = {};
      }
    } catch (_) {}

    this.save(data.token || "", data.record || null, extractAuthTokenMeta(data));
  }

  /**
   * Exports the current store state as cookie string.
   *
   * By default the following optional attributes are added:
   * - Secure
   * - HttpOnly
   * - SameSite=Strict
   * - Path=/
   * - Expires={the token expiration date} (a session cookie if a refresh token is stored)
   *
   * NB! If the generated cookie exceeds 4096 bytes, this method will
   * strip the model data to the bare minimum to try to fit within the
   * recommended size in https://www.rfc-editor.org/rfc/rfc6265#section-6.1.
   */
  exportToCookie(options?: SerializeOptions, key = defaultCookieKey): string {
    const defaultOptions: SerializeOptions = {
      secure: true,
      sameSite: true,
      httpOnly: true,
      path: "/",
    };

    // extract the token expiration date
    // (the refresh token outlives the access token so the cookie is kept for the browser session)
    const exp = this.expiresAt;
    if (!this.token) {
      defaultOptions.expires = new Date("1970-01-01");
    } else if (!this.refreshToken) {
      defaultOptions.expires = exp ? new Date(exp * 1000) : new Date("1970-01-01");
    }

    // merge with the user defined options
    options = Object.assign({}, defaultOptions, options);

    const rawData: { [key: string]: any } = Object.assign({}, this.meta, {
      token: this.token,
      record: this.record ? JSON.parse(JSON.stringify(this.record)) : null,
    });

    let result = cookieSerialize(key, JSON.stringify(rawData), options);

    const resultLength = typeof Blob !== "undefined" ? new Blob([result]).size : result.length;

    // strip down the model data to the bare minimum
    if (rawData.record && resultLength > 4096) {
      rawData.record = {
        id: rawData.record?.id,
        email: rawData.record?.email,
      } as any;
      const extraProps = ["collectionId", "collectionName", "verified"];
      for (const prop in this.record) {
        if (extraProps.includes(prop)) {
          rawData.record[prop] = this.record[prop];
        }
      }
      result = cookieSerialize(key, JSON.stringify(rawData), options);
    }

    return result;
  }

  /**
   * Register a callback function that will be called on store change.
   *
   * You can set the `fireImmediately` argument to true in order to invoke
   * the provided callback right after registration.
   *
   * Returns a removal function that you could call to "unsubscribe" from the changes.
   */
  onChange(callback: OnStoreChangeFunc, fireImmediately = false): () => void {
    this._onChangeCallbacks.push(callback);

    if (fireImmediately) {
      callback(this.token, this.record);
    }

    return () => {
      for (let i = this._onChangeCallbacks.length - 1; i >= 0; i--) {
        if (this._onChangeCallbacks[i] == callback) {
          delete this._onChangeCallbacks[i]; // removes the function reference
          this._onChangeCallbacks.splice(i, 1); // reindex the array
          return;
        }
      }
    };
  }

  protected triggerChange(): void {
    for (const callback of this._onChangeCallbacks) {
      if (callback) {
        callback(this.token, this.record);
      }
    }
  }
}
