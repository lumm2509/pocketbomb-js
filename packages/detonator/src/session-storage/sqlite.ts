import type { DatabaseSync } from "node:sqlite";
import type { Installation, OnlineSession, SessionStorage } from "./types";

/**
 * A {@link SessionStorage} persisted in a SQLite database with the Node.js built-in
 * `node:sqlite` module (Node.js >= 22.13; no extra dependency).
 */
export class SqliteSessionStorage implements SessionStorage {
  readonly db: DatabaseSync;

  /**
   * @param path The database file (":memory:" for an in-memory database).
   */
  constructor(path: string) {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    if (!sqlite?.DatabaseSync) {
      throw new Error("SqliteSessionStorage requires the Node.js built-in node:sqlite module.");
    }

    this.db = new sqlite.DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS detonator_installations (
        issuer TEXT NOT NULL,
        id     TEXT NOT NULL,
        data   TEXT NOT NULL,
        PRIMARY KEY (issuer, id)
      );
      CREATE TABLE IF NOT EXISTS detonator_sessions (
        id              TEXT PRIMARY KEY,
        issuer          TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_detonator_sessions_installation
        ON detonator_sessions (issuer, installation_id);
      CREATE TABLE IF NOT EXISTS detonator_used_tokens (
        jti        TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async storeInstallation(installation: Installation): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO detonator_installations (issuer, id, data) VALUES (?, ?, ?) " +
          "ON CONFLICT (issuer, id) DO UPDATE SET data = excluded.data",
      )
      .run(installation.issuer, installation.id, JSON.stringify(installation));
  }

  async loadInstallation(issuer: string, id: string): Promise<Installation | undefined> {
    const row = this.db
      .prepare("SELECT data FROM detonator_installations WHERE issuer = ? AND id = ?")
      .get(issuer, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  async findInstallationsByIssuer(issuer: string): Promise<Array<Installation>> {
    const rows = this.db
      .prepare("SELECT data FROM detonator_installations WHERE issuer = ? ORDER BY rowid")
      .all(issuer) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data));
  }

  async listInstallations(): Promise<Array<Installation>> {
    const rows = this.db
      .prepare("SELECT data FROM detonator_installations ORDER BY rowid")
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data));
  }

  async deleteInstallation(issuer: string, id: string): Promise<void> {
    this.db
      .prepare("DELETE FROM detonator_installations WHERE issuer = ? AND id = ?")
      .run(issuer, id);
    await this.deleteSessionsByInstallation(issuer, id);
  }

  async storeSession(session: OnlineSession): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO detonator_sessions (id, issuer, installation_id, data) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      )
      .run(session.id, session.issuer, session.installationId, JSON.stringify(session));
  }

  async loadSession(id: string): Promise<OnlineSession | undefined> {
    const row = this.db.prepare("SELECT data FROM detonator_sessions WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare("DELETE FROM detonator_sessions WHERE id = ?").run(id);
  }

  async deleteSessionsByInstallation(issuer: string, installationId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM detonator_sessions WHERE issuer = ? AND installation_id = ?")
      .run(issuer, installationId);
  }

  async markTokenUsed(jti: string, expiresAt: number): Promise<boolean> {
    this.db
      .prepare("DELETE FROM detonator_used_tokens WHERE expires_at < ?")
      .run(Math.floor(Date.now() / 1000));
    const result = this.db
      .prepare("INSERT OR IGNORE INTO detonator_used_tokens (jti, expires_at) VALUES (?, ?)")
      .run(jti, expiresAt);
    return Number(result.changes) === 1;
  }
}
