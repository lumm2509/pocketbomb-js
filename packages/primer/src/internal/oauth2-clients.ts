import type { Client } from "../client";
import { BaseService } from "../services/base";
import { RecordService } from "../records/records";
import { Permissions } from "./roles";
import { RecordModel } from "../tools/dtos";
import { CollectionModel } from "./dtos";
import { CommonOptions } from "../tools/options";

export interface OAuth2ClientModel extends RecordModel {
  name: string;
  clientId: string;
  type: "public" | "confidential" | string;
  collectionRef: string;
  redirectURIs: Array<string>;
  postLogoutRedirectURIs: Array<string>;
  scopes: Array<string>;
  grantTypes: Array<string>;
  firstParty: boolean;
  disabled: boolean;
  applicationInstallationRef: string;

  /**
   * Whether the client has a secret (the secret itself is never returned).
   */
  hasClientSecret?: boolean;
}

export interface OAuth2ClientSecret {
  clientId: string;
  clientSecret: string;
}

export interface APIKeyModel {
  [key: string]: any;

  id: string;
  name: string;
  clientRef: string;
  kind: "public" | "private";
  buyerContext: "required" | "none" | "";
  tokenPrefix: string;

  /**
   * The full public key token (always empty for the private keys).
   */
  token: string;

  permissions: Permissions;
  allowedOrigins: Array<string>;
  disabled: boolean;
  expired: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdBy: string;
  created: string;
  updated: string;
}

export interface APIKeyCreateData {
  name: string;
  kind: "public" | "private";
  /**
   * Private keys only: "required" (default) requires the `X-PB-Buyer-IP` header,
   * "none" is for the requests without end-user (e.g. background jobs).
   */
  buyerContext?: "required" | "none";
  allowedOrigins?: Array<string>;
  permissions?: Permissions;
  expiresAt?: string;
}

export interface APIKeyUpdateData {
  name?: string;
  disabled?: boolean;
  allowedOrigins?: Array<string>;
  permissions?: Permissions;
  expiresAt?: string;
}

/**
 * The response of the API key create and rotate actions
 * (the private key `token` is returned only once).
 */
export interface APIKeyTokenResponse {
  apiKey: APIKeyModel;
  token: string;
}

/**
 * APIKeyService handles the API keys of a single OAuth2 client.
 */
export class APIKeyService extends BaseService {
  readonly clientRecordId: string;

  constructor(client: Client, clientRecordId: string) {
    super(client);

    this.clientRecordId = clientRecordId;
  }

  /**
   * The API keys base path (`/api/oauth2/clients/{id}/api-keys`).
   */
  get basePath(): string {
    return "/api/oauth2/clients/" + encodeURIComponent(this.clientRecordId) + "/api-keys";
  }

  /**
   * Returns all API keys of the OAuth2 client.
   *
   * @throws {ClientResponseError}
   */
  async getFullList(options?: CommonOptions): Promise<Array<APIKeyModel>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send(this.basePath, options);
  }

  /**
   * Creates a new API key (the private key token is returned only once).
   *
   * @throws {ClientResponseError}
   */
  async create(data: APIKeyCreateData, options?: CommonOptions): Promise<APIKeyTokenResponse> {
    options = Object.assign({ method: "POST", body: data }, options);

    return this.client.send(this.basePath, options);
  }

  /**
   * Updates the specified API key (name, disabled, allowed origins, permissions, expiration).
   *
   * @throws {ClientResponseError}
   */
  async update(
    keyId: string,
    data: APIKeyUpdateData,
    options?: CommonOptions,
  ): Promise<APIKeyModel> {
    options = Object.assign({ method: "PATCH", body: data }, options);

    return this.client.send(this.basePath + "/" + encodeURIComponent(keyId), options);
  }

  /**
   * Generates a new token for the specified API key (the old one stops working immediately).
   *
   * @throws {ClientResponseError}
   */
  async rotateSecret(keyId: string, options?: CommonOptions): Promise<APIKeyTokenResponse> {
    options = Object.assign({ method: "POST" }, options);

    return this.client.send(
      this.basePath + "/" + encodeURIComponent(keyId) + "/rotate-secret",
      options,
    );
  }

  /**
   * Deletes the specified API key.
   *
   * @throws {ClientResponseError}
   */
  async delete(keyId: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "DELETE" }, options);

    return this.client
      .send(this.basePath + "/" + encodeURIComponent(keyId), options)
      .then(() => true);
  }
}

/**
 * OAuth2ClientService handles the OAuth2 server clients.
 *
 * The clients CRUD uses the regular records API of the `_oauth2Clients` system
 * collection (inherited `getList`, `getOne`, `create`, `update`, `delete`, etc.).
 */
export class OAuth2ClientService extends RecordService<OAuth2ClientModel> {
  constructor(client: Client) {
    super(client, "_oauth2Clients");
  }

  /**
   * Returns the API keys service of the specified OAuth2 client (record id).
   */
  apiKeys(clientRecordId: string): APIKeyService {
    return new APIKeyService(this.client, clientRecordId);
  }

  /**
   * Generates a new secret for the specified confidential OAuth2 client (record id).
   *
   * The new secret is returned only once.
   *
   * @throws {ClientResponseError}
   */
  async rotateSecret(clientRecordId: string, options?: CommonOptions): Promise<OAuth2ClientSecret> {
    options = Object.assign({ method: "POST" }, options);

    return this.client.send(
      "/api/oauth2/clients/" + encodeURIComponent(clientRecordId) + "/rotate-secret",
      options,
    );
  }

  /**
   * Generates a new active signing key for the issuer of the specified
   * auth collection (the previous keys remain in the JWKS for verification).
   *
   * Returns the updated auth collection.
   *
   * @throws {ClientResponseError}
   */
  async rotateSigningKey(
    collectionIdOrName: string,
    alg: "RS256" | "ES256" = "RS256",
    options?: CommonOptions,
  ): Promise<CollectionModel> {
    options = Object.assign({ method: "POST", body: { alg } }, options);

    return this.client.send(
      "/api/oauth2/" + encodeURIComponent(collectionIdOrName) + "/keys/rotate",
      options,
    );
  }
}
