import type { Installation, OnlineSession, SessionStorage } from "./types";

const key = (issuer: string, id: string) => issuer + "\n" + id;

/**
 * An in-memory {@link SessionStorage} (development and tests; the data is lost on restart).
 */
export class MemorySessionStorage implements SessionStorage {
  private installations = new Map<string, Installation>();
  private sessions = new Map<string, OnlineSession>();
  private usedTokens = new Map<string, number>();

  async storeInstallation(installation: Installation): Promise<void> {
    this.installations.set(
      key(installation.issuer, installation.id),
      structuredClone(installation),
    );
  }

  async loadInstallation(issuer: string, id: string): Promise<Installation | undefined> {
    const found = this.installations.get(key(issuer, id));
    return found ? structuredClone(found) : undefined;
  }

  async findInstallationsByIssuer(issuer: string): Promise<Array<Installation>> {
    return (await this.listInstallations()).filter((i) => i.issuer === issuer);
  }

  async listInstallations(): Promise<Array<Installation>> {
    return Array.from(this.installations.values(), (i) => structuredClone(i));
  }

  async deleteInstallation(issuer: string, id: string): Promise<void> {
    this.installations.delete(key(issuer, id));
    await this.deleteSessionsByInstallation(issuer, id);
  }

  async storeSession(session: OnlineSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async loadSession(id: string): Promise<OnlineSession | undefined> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteSessionsByInstallation(issuer: string, installationId: string): Promise<void> {
    for (const [id, s] of this.sessions) {
      if (s.issuer === issuer && s.installationId === installationId) {
        this.sessions.delete(id);
      }
    }
  }

  async markTokenUsed(jti: string, expiresAt: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of this.usedTokens) {
      if (exp < now) {
        this.usedTokens.delete(id);
      }
    }

    if (this.usedTokens.has(jti)) {
      return false;
    }
    this.usedTokens.set(jti, expiresAt);
    return true;
  }
}
