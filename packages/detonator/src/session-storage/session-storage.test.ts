import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, describe, test } from "vitest";
import { MemorySessionStorage } from "./memory";
import { SqliteSessionStorage } from "./sqlite";
import type { Installation, OnlineSession, SessionStorage } from "./types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detonator-storage-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function installation(issuer: string, id: string, extra: Partial<Installation> = {}): Installation {
  return {
    id,
    issuer,
    url: issuer.replace("/oauth2/_applicationInstallations", ""),
    handle: "my-app",
    clientId: "pba_" + id,
    clientSecret: "secret_" + id,
    webhookSecret: "whsec_" + id,
    scopes: ["read_orders"],
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function session(id: string, issuer: string, installationId: string): OnlineSession {
  return {
    id,
    issuer,
    installationId,
    accessToken: "token_" + id,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    scope: "read_orders",
    staff: { id: "staff1", roles: ["Manager"] },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const A = "https://a.example.com/oauth2/_applicationInstallations";
const B = "https://b.example.com/oauth2/_applicationInstallations";

function storageSuite(name: string, create: () => SessionStorage) {
  describe(name, function () {
    test("installations: store/update/load/find/list/delete (keyed by issuer + id)", async function () {
      const storage = create();

      await storage.storeInstallation(installation(A, "i1"));
      await storage.storeInstallation(installation(B, "i1")); // same id, another instance
      await storage.storeInstallation(installation(A, "i2"));

      assert.equal((await storage.loadInstallation(A, "i1"))?.clientSecret, "secret_i1");
      assert.equal((await storage.loadInstallation(B, "i1"))?.issuer, B);
      assert.isUndefined(await storage.loadInstallation(A, "missing"));

      await storage.storeInstallation(installation(A, "i1", { clientSecret: "rotated" }));
      assert.equal((await storage.loadInstallation(A, "i1"))?.clientSecret, "rotated");

      assert.deepEqual(
        (await storage.findInstallationsByIssuer(A)).map((i) => i.id),
        ["i1", "i2"],
      );
      assert.lengthOf(await storage.listInstallations(), 3);

      await storage.storeSession(session("s1", A, "i1"));
      await storage.storeSession(session("s2", B, "i1"));
      await storage.deleteInstallation(A, "i1");
      assert.isUndefined(await storage.loadInstallation(A, "i1"));
      assert.isUndefined(await storage.loadSession("s1"), "the installation sessions are deleted");
      assert.isDefined(await storage.loadSession("s2"), "the other instance sessions are kept");
    });

    test("online sessions", async function () {
      const storage = create();
      const s = session("s1", A, "i1");

      await storage.storeSession(s);
      assert.deepEqual(await storage.loadSession("s1"), s);

      await storage.storeSession({ ...s, accessToken: "changed" });
      assert.equal((await storage.loadSession("s1"))?.accessToken, "changed");

      await storage.storeSession(session("s2", A, "i1"));
      await storage.storeSession(session("s3", A, "i2"));
      await storage.deleteSession("s1");
      assert.isUndefined(await storage.loadSession("s1"));

      await storage.deleteSessionsByInstallation(A, "i1");
      assert.isUndefined(await storage.loadSession("s2"));
      assert.isDefined(await storage.loadSession("s3"));
    });

    test("markTokenUsed() is replay safe and prunes the expired ids", async function () {
      const storage = create();
      const now = Math.floor(Date.now() / 1000);

      assert.isTrue(await storage.markTokenUsed("jti1", now + 60));
      assert.isFalse(await storage.markTokenUsed("jti1", now + 60), "replay");
      assert.isTrue(await storage.markTokenUsed("jti2", now + 60));

      // an expired entry is pruned (a new token can't reuse it before it expires anyway)
      assert.isTrue(await storage.markTokenUsed("old", now - 10));
      assert.isTrue(await storage.markTokenUsed("old", now + 60), "the expired entry was pruned");
    });

    test("the returned objects are copies", async function () {
      const storage = create();
      await storage.storeInstallation(installation(A, "i1"));
      const loaded = (await storage.loadInstallation(A, "i1"))!;
      loaded.clientSecret = "mutated";
      assert.equal((await storage.loadInstallation(A, "i1"))?.clientSecret, "secret_i1");
    });
  });
}

storageSuite("MemorySessionStorage", () => new MemorySessionStorage());
storageSuite("SqliteSessionStorage (:memory:)", () => new SqliteSessionStorage(":memory:"));

describe("SqliteSessionStorage (file)", function () {
  test("persists across instances (node:sqlite)", async function () {
    const file = path.join(tmp, "sessions.sqlite");

    const first = new SqliteSessionStorage(file);
    await first.storeInstallation(installation(A, "i1"));
    await first.storeSession(session("s1", A, "i1"));
    await first.markTokenUsed("jti", Math.floor(Date.now() / 1000) + 60);
    first.close();

    const second = new SqliteSessionStorage(file);
    assert.equal((await second.loadInstallation(A, "i1"))?.clientId, "pba_i1");
    assert.equal((await second.loadSession("s1"))?.staff.id, "staff1");
    assert.isFalse(await second.markTokenUsed("jti", Math.floor(Date.now() / 1000) + 60));
    second.close();
  });
});
