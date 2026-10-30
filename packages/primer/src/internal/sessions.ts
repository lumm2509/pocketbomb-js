import type { Client } from "../client";
import { RecordService } from "../records/records";
import { RecordModel } from "../tools/dtos";
import { CommonOptions, RecordListOptions } from "../tools/options";

export interface AuthSessionModel extends RecordModel {
  status: "pending" | "authenticated" | "authorized" | "active" | "ended" | "failed" | string;
  collectionRef: string;
  recordRef: string;
  client: string;
  parent: string;
  scopes: Array<string>;
  ip: string;
  userAgent: string;
  lastUsedAt: string;
  expiresAt: string;

  /**
   * Whether it is a root SSO (browser) session.
   */
  sso?: boolean;
}

/**
 * SessionService handles the staff management of the OAuth2 auth sessions
 * (requires the `sessions` permission).
 *
 * The sessions are read with the regular records API of the `_authSessions`
 * system collection (inherited `getList`, `getOne`, etc.).
 */
export class SessionService extends RecordService<AuthSessionModel> {
  constructor(client: Client) {
    super(client, "_authSessions");
  }

  /**
   * Returns the active (not ended and not expired) sessions of the specified auth record.
   *
   * @throws {ClientResponseError}
   */
  async getActiveList(
    collectionId: string,
    recordId: string,
    options?: RecordListOptions,
  ): Promise<Array<AuthSessionModel>> {
    const filter = this.client.filter(
      "collectionRef={:collectionId} && recordRef={:recordId} && status='active' && expiresAt>@now",
      { collectionId, recordId },
    );

    return this.getFullList(
      Object.assign({ sort: "-lastUsedAt", expand: "client" }, options, {
        filter: options?.filter ? `(${filter}) && (${options.filter})` : filter,
      }),
    );
  }

  /**
   * Ends (revokes) the specified session with the regular cascade: ending a root SSO
   * session ends its non-offline children and ending any session ends the impersonations
   * issued with it (`POST /api/sessions/{id}/end`).
   *
   * Requires the sessions write permission (the sessions of an Owner or of a more
   * privileged staff member could be ended only by an Owner).
   *
   * @throws {ClientResponseError}
   */
  async end(id: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "POST" }, options);

    return this.client
      .send("/api/sessions/" + encodeURIComponent(id) + "/end", options)
      .then(() => true);
  }
}
