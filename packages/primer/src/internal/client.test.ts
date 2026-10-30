import { afterAll, afterEach, assert, beforeAll, describe, test } from "vitest";
import { AuthStore } from "../auth/store";
import { Client } from "../client";
import { dummyJWT, FetchMock } from "../test-utils/mocks";
import { BackupService } from "./backups";
import { createDashboardClient, DashboardClient } from "./client";
import { CollectionService } from "./collections";
import { CronService } from "./crons";
import { LogService } from "./logs";
import { SettingsService } from "./settings";
import { SQLService } from "./sql";

const base = "http://test.local";

function form(config: any): URLSearchParams {
  return new URLSearchParams(config?.body || "");
}

describe("DashboardClient", function () {
  const fetchMock = new FetchMock();

  beforeAll(function () {
    fetchMock.init();
  });

  afterAll(function () {
    fetchMock.restore();
  });

  afterEach(function () {
    fetchMock.clearMocks();
  });

  test("Should be a regular client with the dashboard internal services", function () {
    const client = new DashboardClient(base, { lang: "bg-BG" });

    assert.instanceOf(client, Client);
    assert.equal(client.lang, "bg-BG");
    assert.instanceOf(client.settings, SettingsService);
    assert.instanceOf(client.collections, CollectionService);
    assert.instanceOf(client.logs, LogService);
    assert.instanceOf(client.backups, BackupService);
    assert.instanceOf(client.crons, CronService);
    assert.instanceOf(client.sql, SQLService);
    assert.isFalse(client.isAccountClient);
  });

  test("createDashboardClient() creates an account dashboard client", function () {
    const store = new AuthStore();
    const client = createDashboardClient({
      url: base,
      collection: "_superusers",
      clientId: "pb_dashboard",
      redirectUri: base + "/_/",
      authStore: store,
      lockName: "dashboard_lock",
      backgroundRefresh: false,
    });

    assert.instanceOf(client, DashboardClient);
    assert.equal(client.authStore, store);
    assert.isTrue(client.isAccountClient);
    assert.equal(client.authStrategy, client.account);
    assert.equal(client.account.config.lockName, "dashboard_lock");
    assert.equal(client.account.issuerPath, "/oauth2/_superusers");

    // default store outside of browsers
    const other = createDashboardClient({
      url: base,
      collection: "_superusers",
      clientId: "pb_dashboard",
      redirectUri: base + "/_/",
    });
    assert.instanceOf(other.authStore, AuthStore);
  });

  test("impersonate() should retry once with a refreshed actor token", async function () {
    const client = createDashboardClient({
      url: base,
      collection: "_superusers",
      clientId: "pb_dashboard",
      redirectUri: base + "/_/",
      authStore: new AuthStore(),
      lockName: "test_lock_" + Math.random(),
      backgroundRefresh: false,
    });

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const oldToken = dummyJWT({ exp, v: 1 });
    const newToken = dummyJWT({ exp, v: 2 });
    client.authStore.save(oldToken, null, { refreshToken: "rt1" });

    fetchMock.on({
      method: "POST",
      url: base + "/oauth2/customers/token",
      additionalMatcher: (_, config: any) => {
        const f = form(config);
        return (
          f.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" &&
          f.get("subject_token") === "r1" &&
          f.get("subject_token_type") === "urn:pocketbase:params:oauth:token-type:record_id" &&
          f.get("actor_token") === oldToken &&
          f.get("client_id") === "pb_dashboard"
        );
      },
      replyCode: 400,
      replyBody: { error: "invalid_grant" },
    });
    fetchMock.on({
      method: "POST",
      url: base + "/oauth2/_superusers/token",
      additionalMatcher: (_, config: any) => form(config).get("refresh_token") === "rt1",
      replyCode: 200,
      replyBody: { access_token: newToken, refresh_token: "rt2", expires_in: 3600 },
    });
    fetchMock.on({
      method: "GET",
      url: base + "/api/permissions/me",
      replyCode: 200,
      replyBody: { kind: "staff", record: { id: "s1", collectionName: "_superusers" } },
    });
    fetchMock.on({
      method: "POST",
      url: base + "/oauth2/customers/token",
      additionalMatcher: (_, config: any) => form(config).get("actor_token") === newToken,
      replyCode: 200,
      replyBody: { access_token: "imp", expires_in: 60 },
    });

    const result = await client.impersonate("customers", "r1");
    assert.equal(result.access_token, "imp");
    assert.equal(client.authStore.refreshToken, "rt2");
  });
});
