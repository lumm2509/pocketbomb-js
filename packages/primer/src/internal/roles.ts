import type { Client } from "../client";
import { RecordService } from "../records/records";
import { RecordModel } from "../tools/dtos";
import { CommonOptions } from "../tools/options";

/**
 * RBAC permissions (collection actions per collection id or "*"
 * and system resource levels).
 */
export interface Permissions {
  /**
   * Collection id (or "*") => list of actions (list, view, create, update, delete).
   */
  collections?: { [collectionIdOrWildcard: string]: Array<string> };

  /**
   * System resource name => level ("read" or "write").
   */
  system?: { [resource: string]: string };
}

export interface PermissionResource {
  [key: string]: any;

  name: string;
  label: string;
  levels: Array<string>;
  ownerOnlyLevels: Array<string>;
  assignable: boolean;
  applicationGrantable: boolean;
  note?: string;
}

export interface RoleModel {
  [key: string]: any;

  id: string;
  name: string;
  description: string;
  permissions: Permissions;
  system: boolean;
  owner: boolean;
  created: string;
  updated: string;
}

export interface RolesRegistry {
  items: Array<RoleModel>;
  resources: Array<PermissionResource>;
  actions: Array<string>;
}

export interface RoleAssignments {
  collectionId: string;
  recordId: string;

  /**
   * Whether the record has explicit assignments (otherwise the collection default roles apply).
   */
  explicit: boolean;

  /**
   * The explicitly assigned role ids.
   */
  roles: Array<string>;

  /**
   * The effective role ids (the explicit ones or the collection default roles).
   */
  effective: Array<string>;

  owner: boolean;
  permissions: Permissions;
}

/**
 * The resolved RBAC permissions of the current actor (`GET /api/permissions/me`).
 */
export interface ActorPermissions {
  [key: string]: any;

  kind: "guest" | "customer" | "staff" | "application" | string;
  owner: boolean;
  roles: Array<string>;
  roleIds: Array<string>;
  permissions: Permissions;
  thirdParty: boolean;
  scopes: Array<string>;
  onBehalfOf?: { kind: string; installationId: string; applicationId: string };

  /**
   * The collection ids visible to the actor (staff and applications only).
   */
  collections: Array<string>;

  /**
   * The actor own auth record (never the secret fields; for the third-party
   * tokens only with the "openid"+"profile" or "email" scopes).
   */
  record?: RecordModel;

  application?: {
    id: string;
    handle: string;
    name: string;
    installationId: string;
    versionId: string;
    version: string;
    clientId: string;
  };

  registry: {
    resources: Array<PermissionResource>;
    actions: Array<string>;
    systemCollections: { [collectionName: string]: string };
  };
}

/**
 * RoleService handles the RBAC roles.
 *
 * The roles CRUD uses the regular records API of the `_roles` system
 * collection (inherited `getList`, `getOne`, `create`, `update`, `delete`, etc.).
 */
export class RoleService extends RecordService<RoleModel> {
  constructor(client: Client) {
    super(client, "_roles");
  }

  /**
   * Returns all roles together with the RBAC registry vocabulary
   * (permission resources and collection actions).
   *
   * @throws {ClientResponseError}
   */
  async registry(options?: CommonOptions): Promise<RolesRegistry> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/roles", options);
  }

  /**
   * Returns the role assignments of the specified auth record.
   *
   * @throws {ClientResponseError}
   */
  async getAssignments(
    collectionIdOrName: string,
    recordId: string,
    options?: CommonOptions,
  ): Promise<RoleAssignments> {
    options = Object.assign({ method: "GET" }, options);
    options.query = Object.assign(
      { collection: collectionIdOrName, record: recordId },
      options.query,
    );

    return this.client.send("/api/roles/assignments", options);
  }

  /**
   * Replaces the explicit role assignments of the specified auth record
   * (an empty list means that the collection default roles apply).
   *
   * @throws {ClientResponseError}
   */
  async setAssignments(
    collectionIdOrName: string,
    recordId: string,
    roleIds: Array<string>,
    options?: CommonOptions,
  ): Promise<RoleAssignments> {
    options = Object.assign(
      {
        method: "PUT",
        body: {
          collection: collectionIdOrName,
          record: recordId,
          roles: roleIds,
        },
      },
      options,
    );

    return this.client.send("/api/roles/assignments", options);
  }

  /**
   * Returns the resolved RBAC permissions (and own record) of the current actor.
   *
   * @throws {ClientResponseError}
   */
  async me(options?: CommonOptions): Promise<ActorPermissions> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/permissions/me", options);
  }
}
