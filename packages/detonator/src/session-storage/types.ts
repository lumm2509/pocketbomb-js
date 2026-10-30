/**
 * An application installation of a PocketBomb instance (the offline credentials).
 *
 * The installation key is (issuer, id): a catalog application can be installed in many instances.
 */
export interface Installation {
  /** The installation id (`installation_id`). */
  id: string;
  /** The `_applicationInstallations` issuer identifier of the instance (`iss`). */
  issuer: string;
  /** The PocketBomb base URL of the instance. */
  url: string;
  /** The application handle (the notifications `aud`). */
  handle: string;
  /** The installation OAuth2 client credentials. */
  clientId: string;
  clientSecret: string;
  /** The managed webhooks signing secret. */
  webhookSecret: string;
  /** The granted scopes. */
  scopes: Array<string>;
  /** The installed manifest version. */
  version: string;
  /** The public app proxy path ("/{prefix}/{subpath}", `path_prefix` of the proxied requests). */
  proxyPathPrefix?: string;
  /** ISO dates. */
  installedAt: string;
  updatedAt: string;
}

/**
 * An online (staff) session of an embedded application, keyed by (installation, staff dashboard session).
 */
export interface OnlineSession {
  /** The session key (see `onlineSessionId`). */
  id: string;
  issuer: string;
  installationId: string;
  /** The online access token (staff ∩ grant; it can't be refreshed). */
  accessToken: string;
  /** The access token expiration (unix seconds). */
  expiresAt: number;
  scope: string;
  /** The staff member (`sub` + the token exchange `associated_user`). */
  staff: { id: string; roles: Array<string> };
  createdAt: string;
}

/**
 * The detonator storage of the installations, the online sessions and the used
 * notification/launch token ids (replay protection).
 */
export interface SessionStorage {
  storeInstallation(installation: Installation): Promise<void>;
  loadInstallation(issuer: string, id: string): Promise<Installation | undefined>;
  /** The installations of an instance (an application is installed at most once per instance). */
  findInstallationsByIssuer(issuer: string): Promise<Array<Installation>>;
  listInstallations(): Promise<Array<Installation>>;
  /** Deletes the installation and its online sessions. */
  deleteInstallation(issuer: string, id: string): Promise<void>;

  storeSession(session: OnlineSession): Promise<void>;
  loadSession(id: string): Promise<OnlineSession | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsByInstallation(issuer: string, installationId: string): Promise<void>;

  /**
   * Marks a token id (`jti`) as used until `expiresAt` (unix seconds).
   * Resolves to false if it was already used (a replay); the expired entries are pruned.
   */
  markTokenUsed(jti: string, expiresAt: number): Promise<boolean>;
}
