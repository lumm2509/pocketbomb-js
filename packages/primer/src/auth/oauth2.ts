import type { Client } from "../client";
import type { SendOptions } from "../tools/options";

/**
 * OAuth2 grant types supported by the PocketBomb OAuth2 server.
 */
export const OAuth2GrantType = {
  authorizationCode: "authorization_code",
  refreshToken: "refresh_token",
  clientCredentials: "client_credentials",
  tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
} as const;

/**
 * RFC 8693 token types used by the PocketBomb token exchange.
 */
export const OAuth2TokenType = {
  accessToken: "urn:ietf:params:oauth:token-type:access_token",
  recordId: "urn:pocketbase:params:oauth:token-type:record_id",
  launchToken: "urn:pocketbase:params:oauth:token-type:launch_token",
} as const;

/**
 * The PocketBomb OAuth2 server token endpoint response.
 */
export interface OAuth2TokenResponse {
  [key: string]: any;

  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
  issued_token_type?: string;

  /**
   * The staff member of an application extension online token (launch token exchange).
   */
  associated_user?: { id: string; roles: Array<string> };
}

/**
 * Optional confidential client credentials (sent with the client_secret_basic method).
 */
export interface OAuth2ClientAuth {
  clientId: string;
  clientSecret?: string;
}

/**
 * Returns the PocketBomb OAuth2 issuer path of the specified auth collection
 * (e.g. "/oauth2/users").
 */
export function oauth2IssuerPath(collection: string): string {
  return "/oauth2/" + encodeURIComponent(collection);
}

/**
 * Encodes the client credentials for the client_secret_basic method
 * (the credentials are form-urlencoded first, RFC 6749 section 2.3.1).
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encode = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");

  return "Basic " + btoa(encode(clientId) + ":" + encode(clientSecret));
}

/**
 * Sends a form-urlencoded OAuth2 protocol request (token, revoke, introspect)
 * to the specified issuer endpoint.
 *
 * The request is sent without the auth store token (`skipAuth`) and without
 * auto cancellation. Confidential clients are authenticated with client_secret_basic;
 * public clients send only the `client_id` body parameter.
 *
 * The OAuth2 error responses (`error`, `error_description`) are thrown as `ClientResponseError`.
 *
 * @throws {ClientResponseError}
 */
export async function oauth2FormRequest<T = any>(
  client: Client,
  path: string,
  values: { [key: string]: string | undefined | null },
  auth?: OAuth2ClientAuth,
  options: SendOptions = {},
): Promise<T> {
  const body = new URLSearchParams();
  for (const key in values) {
    const v = values[key];
    if (v !== undefined && v !== null && v !== "") {
      body.set(key, v);
    }
  }

  const headers: { [key: string]: string } = Object.assign({}, options.headers, {
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (auth?.clientSecret) {
    headers["Authorization"] = basicAuthHeader(auth.clientId, auth.clientSecret);
  } else if (auth?.clientId) {
    body.set("client_id", auth.clientId);
  }

  return client.send<T>(
    path,
    Object.assign({ requestKey: null }, options, {
      method: "POST",
      headers,
      body: body.toString(),
      skipAuth: true,
    }),
  );
}

/**
 * Converts the provided `expires_in` (seconds) into an absolute unix timestamp (seconds).
 */
export function expiresInToTimestamp(expiresIn?: number): number | undefined {
  if (!expiresIn || expiresIn <= 0) {
    return undefined;
  }

  return Math.floor(Date.now() / 1000) + expiresIn;
}
