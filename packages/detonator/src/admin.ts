import {
  assertServerOnly,
  AuthStore,
  Client,
  expiresInToTimestamp,
  OAuth2GrantType,
  oauth2FormRequest,
  oauth2IssuerPath,
  OAuth2TokenType,
  type AuthStrategy,
  type OAuth2TokenResponse,
} from "pocketbomb-primer";

/**
 * The OAuth2 issuer (auth collection) of the application installations
 * (client_credentials and launch token exchange).
 */
export const applicationInstallationsCollection = "_applicationInstallations";

interface BaseAdminOptions {
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
   * Allows the client secret in a browser. NB! Never ship a client secret to the browsers.
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface AdminClientOptions extends BaseAdminOptions {
  /**
   * The application installation OAuth2 client_id.
   */
  clientId: string;

  /**
   * The application installation OAuth2 client_secret.
   */
  clientSecret: string;

  /**
   * Optional scopes narrowing the installation grant (default to the full grant).
   */
  scopes?: Array<string>;

  /**
   * The issuer auth collection (default to "_applicationInstallations").
   */
  collection?: string;
}

export interface LaunchTokenExchangeOptions extends AdminClientOptions {
  /**
   * The launch token POSTed by the dashboard to the extension URL (`launch_token` form field).
   */
  launchToken: string;

  /**
   * Whether `launchToken` is an embedded application session token (`pb-session+jwt`).
   */
  sessionToken?: boolean;
}

/**
 * The token exchange `subject_token_type` of the embedded application session tokens.
 */
export const SessionTokenType = "urn:pocketbase:params:oauth:token-type:session_token";

/**
 * The client_credentials auth strategy of the application installations
 * (a new access token is requested before the current one expires).
 */
export class ClientCredentialsStrategy implements AuthStrategy {
  private pending: Promise<boolean> | null = null;

  constructor(
    readonly client: Client,
    readonly options: AdminClientOptions,
  ) {}

  refresh(): Promise<boolean> {
    if (!this.pending) {
      this.pending = this.fetchToken().finally(() => {
        this.pending = null;
      });
    }

    return this.pending;
  }

  private async fetchToken(): Promise<boolean> {
    const tokens = await oauth2FormRequest<OAuth2TokenResponse>(
      this.client,
      oauth2IssuerPath(this.options.collection || applicationInstallationsCollection) + "/token",
      {
        grant_type: OAuth2GrantType.clientCredentials,
        scope: this.options.scopes?.length ? this.options.scopes.join(" ") : undefined,
      },
      { clientId: this.options.clientId, clientSecret: this.options.clientSecret },
    );

    this.client.authStore.save(tokens.access_token, null, {
      scope: tokens.scope,
      clientId: this.options.clientId,
      expiresAt: expiresInToTimestamp(tokens.expires_in),
    });

    return true;
  }
}

/**
 * Creates an application admin client (the offline access of an installation) authenticated
 * with the installation client credentials (client_credentials grant; the token is fetched
 * lazily and re-fetched before it expires).
 *
 * Server-only (it throws in browsers unless `dangerouslyAllowBrowser` is set).
 */
export function createAdminClient(options: AdminClientOptions): Client {
  assertServerOnly("createAdminClient()", options);

  if (!options.clientId || !options.clientSecret) {
    throw new Error("createAdminClient() requires clientId and clientSecret.");
  }

  const client = new Client(options.url, {
    authStore: new AuthStore(),
    lang: options.lang,
    fetch: options.fetch,
    // concurrent server requests must not cancel each other
    autoCancellation: false,
  });
  client.authStrategy = new ClientCredentialsStrategy(client, options);

  return client;
}

/**
 * Exchanges an application extension launch token for an online access token
 * (the staff member acting on behalf of the installation; staff permissions ∩ grant).
 *
 * Returns a client loaded with the online token (it can't be refreshed; a new launch is
 * required after it expires). The staff member is available as
 * `client.authStore.meta.associatedUser` (`{id, roles}`).
 *
 * Server-only (it throws in browsers unless `dangerouslyAllowBrowser` is set).
 *
 * @throws {ClientResponseError}
 */
export async function exchangeLaunchToken(options: LaunchTokenExchangeOptions): Promise<Client> {
  assertServerOnly("exchangeLaunchToken()", options);

  const client = new Client(options.url, {
    authStore: new AuthStore(),
    lang: options.lang,
    fetch: options.fetch,
    autoCancellation: false,
  });

  const tokens = await oauth2FormRequest<OAuth2TokenResponse>(
    client,
    oauth2IssuerPath(options.collection || applicationInstallationsCollection) + "/token",
    {
      grant_type: OAuth2GrantType.tokenExchange,
      subject_token: options.launchToken,
      subject_token_type: options.sessionToken ? SessionTokenType : OAuth2TokenType.launchToken,
    },
    { clientId: options.clientId, clientSecret: options.clientSecret },
  );

  client.authStore.save(tokens.access_token, null, {
    scope: tokens.scope,
    clientId: options.clientId,
    expiresAt: expiresInToTimestamp(tokens.expires_in),
    associatedUser: tokens.associated_user,
  });

  return client;
}

/**
 * Returns the PocketBomb base URL of an `_applicationInstallations` issuer identifier
 * (e.g. "https://example.com/oauth2/_applicationInstallations" -> "https://example.com").
 *
 * @throws {Error} for an invalid issuer.
 */
export function baseURLFromIssuer(issuer: string): string {
  const suffix = "/oauth2/" + applicationInstallationsCollection;
  if (!issuer.endsWith(suffix)) {
    throw new Error("Invalid application installations issuer " + issuer + ".");
  }
  return issuer.substring(0, issuer.length - suffix.length);
}
