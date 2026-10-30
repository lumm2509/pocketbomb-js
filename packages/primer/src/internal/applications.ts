import type { Client } from "../client";
import { BaseService } from "../services/base";
import { Permissions, PermissionResource } from "./roles";
import { CommonOptions } from "../tools/options";

export interface ApplicationManifest {
  [key: string]: any;

  handle: string;
  name: string;
  version: string;
  description?: string;
  application_url?: string;
  install_url?: string;
  uninstall_url?: string;
  icon_url?: string;
  developer?: { name?: string; url?: string };
  access?: { scopes?: Array<string>; optional_scopes?: Array<string> };
  webhooks?: {
    subscriptions?: Array<{
      topics: Array<string>;
      uri: string;
      filter?: string;
      fields?: string;
    }>;
  };
  extensions?: Array<{
    type: "dashboard.navigation" | "dashboard.record_action" | string;
    handle: string;
    label: string;
    path: string;
    collection?: string;
  }>;
}

export interface ApplicationVersionModel {
  id: string;
  version: string;
  sourceFormat: "toml" | "json" | string;
  manifestDigest: string;
  manifest: ApplicationManifest;
  createdBy: string;
  created: string;
}

export interface ApplicationInstallationModel {
  id: string;
  collectionId: string;
  status: "pending" | "active" | string;
  versionRef: string;
  version: string;
  permissions: Permissions;
  scopes: Array<string>;
  clientId: string;
  tokenURL: string;
  installedBy: string;
  secretRotatedAt: string;
  webhooks: Array<{
    id: string;
    name: string;
    uri: string;
    topics: Array<string>;
    filter: string;
    active: boolean;
    disabledReason: string;
  }>;
  created: string;
  updated: string;
}

export interface ApplicationModel {
  id: string;
  handle: string;
  name: string;
  description: string;
  iconURL: string;
  developerName: string;
  developerURL: string;
  applicationURL: string;
  source: "custom" | "catalog" | string;
  catalogURL: string;
  manifestURL: string;
  latestVersion: ApplicationVersionModel | null;
  versions: Array<ApplicationVersionModel>;
  installation: ApplicationInstallationModel | null;
  created: string;
  updated: string;
}

export interface ApplicationsList {
  items: Array<ApplicationModel>;
  resources: Array<PermissionResource>;
  actions: Array<string>;
  superuserIPsRestricted: boolean;
}

export interface ApplicationCreateData {
  handle: string;
  name: string;
  version?: string;
  description?: string;
  applicationURL?: string;
  developerName?: string;
  developerURL?: string;
  scopes?: Array<string>;
}

export interface ApplicationManifestImportResult {
  application: ApplicationModel;
  version: ApplicationVersionModel;
  created: boolean;
  unchanged: boolean;
}

/**
 * The installation credentials (the client and webhook secrets are returned only once
 * and only when they were not delivered with the install notification).
 */
export interface ApplicationCredentials {
  installation: ApplicationInstallationModel;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  tokenURL: string;

  /**
   * Whether the credentials were delivered to the application `install_url`.
   */
  notified: boolean;
}

export interface ApplicationCatalogEntry {
  source: string;
  signed: boolean;
  handle: string;
  name: string;
  description: string;
  iconURL: string;
  developer: { name?: string; url?: string };
  version: string;
  manifestURL: string;
  manifestDigest: string;
  applicationId: string;
  installed: boolean;
  installedVersion: string;
  updateAvailable: boolean;
  conflict: boolean;
}

export interface ApplicationCatalog {
  sources: Array<{
    name: string;
    url: string;
    signed: boolean;
    error: string;
    total: number;
    fetchedAt: string;
  }>;
  items: Array<ApplicationCatalogEntry>;
}

export interface ApplicationCatalogManifest {
  entry: ApplicationCatalogEntry;
  manifest: ApplicationManifest;
  scopes: Array<{ scope: string; label: string; optional: boolean }>;
}

export interface ApplicationExtension {
  installationId: string;
  applicationId: string;
  applicationHandle: string;
  applicationName: string;
  iconURL: string;
  type: string;
  handle: string;
  label: string;
  collection?: string;
  collectionId?: string;
}

export interface ApplicationLaunch {
  /**
   * The extension url (the `launchToken` must be POSTed to it as `launch_token` form field).
   */
  url: string;
  launchToken: string;
}

/**
 * ApplicationCatalogService handles the applications catalog sources.
 */
export class ApplicationCatalogService extends BaseService {
  /**
   * Returns the merged entries of all configured catalog sources
   * (the per source errors are returned in `sources`).
   *
   * @throws {ClientResponseError}
   */
  async getList(options?: CommonOptions & { refresh?: boolean }): Promise<ApplicationCatalog> {
    const { refresh, ...rest } = Object.assign({}, options);
    const sendOptions: CommonOptions = Object.assign({ method: "GET" }, rest);
    if (refresh) {
      sendOptions.query = Object.assign({ refresh: 1 }, sendOptions.query);
    }

    return this.client.send("/api/applications/catalog", sendOptions);
  }

  /**
   * Fetches and verifies the manifest of the specified catalog entry.
   *
   * @throws {ClientResponseError}
   */
  async getManifest(
    source: string,
    handle: string,
    options?: CommonOptions,
  ): Promise<ApplicationCatalogManifest> {
    options = Object.assign({ method: "GET" }, options);
    options.query = Object.assign({ source, handle }, options.query);

    return this.client.send("/api/applications/catalog/manifest", options);
  }

  /**
   * Imports and installs the specified catalog application with the provided grant
   * (the credentials are delivered to the application `install_url`).
   *
   * @throws {ClientResponseError}
   */
  async install(
    source: string,
    handle: string,
    permissions: Permissions,
    options?: CommonOptions,
  ): Promise<ApplicationCredentials> {
    options = Object.assign({ method: "POST", body: { source, handle, permissions } }, options);

    return this.client.send("/api/applications/catalog/install", options);
  }

  /**
   * Imports the current catalog version of the specified entry
   * (e.g. before an installation version update).
   *
   * @throws {ClientResponseError}
   */
  async import(
    source: string,
    handle: string,
    options?: CommonOptions,
  ): Promise<ApplicationManifestImportResult> {
    options = Object.assign({ method: "POST", body: { source, handle } }, options);

    return this.client.send("/api/applications/catalog/import", options);
  }
}

/**
 * ApplicationService handles the applications, their installations and extensions.
 */
export class ApplicationService extends BaseService {
  /**
   * The applications catalog sources.
   */
  readonly catalog: ApplicationCatalogService;

  constructor(client: Client) {
    super(client);

    this.catalog = new ApplicationCatalogService(client);
  }

  /**
   * Returns all applications with their versions and installation status.
   *
   * @throws {ClientResponseError}
   */
  async getList(options?: CommonOptions): Promise<ApplicationsList> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/applications", options);
  }

  /**
   * Creates a custom application from a form (converted to a manifest server-side).
   *
   * @throws {ClientResponseError}
   */
  async create(
    data: ApplicationCreateData,
    options?: CommonOptions,
  ): Promise<ApplicationManifestImportResult> {
    options = Object.assign({ method: "POST", body: data }, options);

    return this.client.send("/api/applications", options);
  }

  /**
   * Imports a custom application manifest (a TOML string or a JSON
   * string/object) as a new application or a new version of an existing one.
   *
   * @throws {ClientResponseError}
   */
  async importManifest(
    manifest: string | ApplicationManifest,
    format: "toml" | "json" = typeof manifest === "string" ? "toml" : "json",
    options?: CommonOptions,
  ): Promise<ApplicationManifestImportResult> {
    options = Object.assign({ method: "POST" }, options, {
      headers: Object.assign({}, options?.headers, {
        "Content-Type": format === "toml" ? "application/toml" : "application/json",
      }),
      body: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    });

    return this.client.send("/api/applications/manifests", options);
  }

  /**
   * Installs the specified (custom) application with the provided grant.
   *
   * @throws {ClientResponseError}
   */
  async install(
    applicationId: string,
    permissions: Permissions,
    options?: CommonOptions,
  ): Promise<ApplicationCredentials> {
    options = Object.assign({ method: "POST", body: { permissions } }, options);

    return this.client.send(
      "/api/applications/" + encodeURIComponent(applicationId) + "/install",
      options,
    );
  }

  /**
   * Updates the grant and/or the version of the specified installation
   * (a version requiring more scopes needs an explicit new grant).
   *
   * @throws {ClientResponseError}
   */
  async update(
    installationId: string,
    data: { permissions?: Permissions; versionRef?: string },
    options?: CommonOptions,
  ): Promise<ApplicationInstallationModel> {
    options = Object.assign({ method: "PATCH", body: data }, options);

    return this.client.send(this.installationPath(installationId), options);
  }

  /**
   * Rotates the client and webhook secrets of the specified installation
   * (all installation sessions are ended).
   *
   * @throws {ClientResponseError}
   */
  async rotateSecret(
    installationId: string,
    options?: CommonOptions,
  ): Promise<ApplicationCredentials> {
    options = Object.assign({ method: "POST" }, options);

    return this.client.send(this.installationPath(installationId) + "/rotate-secret", options);
  }

  /**
   * Uninstalls the specified installation (its client, sessions and managed webhooks are removed).
   *
   * @throws {ClientResponseError}
   */
  async uninstall(installationId: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "DELETE" }, options);

    return this.client.send(this.installationPath(installationId), options).then(() => true);
  }

  /**
   * Deletes the specified (not installed) application.
   *
   * @throws {ClientResponseError}
   */
  async delete(applicationId: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "DELETE" }, options);

    return this.client
      .send("/api/applications/" + encodeURIComponent(applicationId), options)
      .then(() => true);
  }

  /**
   * Returns the dashboard extensions visible to the current staff member.
   *
   * @throws {ClientResponseError}
   */
  async extensions(options?: CommonOptions): Promise<Array<ApplicationExtension>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/applications/extensions", options);
  }

  /**
   * Issues a launch token for the specified installation extension
   * (staff dashboard sessions only). POST it to the returned `url` as `launch_token`
   * form field (never put it in a URL).
   *
   * @throws {ClientResponseError}
   */
  async launch(
    installationId: string,
    extension: string,
    recordId?: string,
    options?: CommonOptions,
  ): Promise<ApplicationLaunch> {
    const body: { [key: string]: string } = { extension };
    if (recordId) {
      body.recordId = recordId;
    }

    options = Object.assign({ method: "POST", body }, options);

    return this.client.send(this.installationPath(installationId) + "/launch", options);
  }

  private installationPath(installationId: string): string {
    return "/api/applications/installations/" + encodeURIComponent(installationId);
  }
}
