import { describe, assert, expect, test, beforeAll, inject } from "vitest";
import { AuthStore, createAccountClient, getTokenPayload } from "@pocketbomb/primer";
import type { DashboardClient } from "@pocketbomb/primer/internal";
import {
  CookieJar,
  followHostedFlow,
  loginAccountClient,
  ownerClient,
  raw,
  staffClient,
} from "./helpers";

const url = inject("pbURL");

const CLIENT_ID = "int_accounts";
const REDIRECT = url + "/accounts/callback";
const ALICE = { email: "alice@example.com", password: "AlicePass12345" };
const BOB = { email: "bob@example.com", password: "BobPass1234567" };
const STAFF = { email: "sessions.staff@example.com", password: "StaffPass12345" };

function accountLogin(credentials: { email: string; password: string }) {
  return loginAccountClient({
    url,
    collection: "users",
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    identity: credentials.email,
    password: credentials.password,
  });
}

describe("sessions + signup (real server)", function () {
  let owner: DashboardClient;

  beforeAll(async function () {
    owner = await ownerClient(url);
    await owner.settings.update({ meta: { appURL: url } });

    const users = await owner.collections.getOne("users");

    await owner.oauth2Clients.create({
      name: "Integration accounts",
      clientId: CLIENT_ID,
      type: "public",
      collectionRef: users.id,
      redirectURIs: [REDIRECT],
      postLogoutRedirectURIs: [REDIRECT],
      scopes: ["openid", "email", "profile"],
      firstParty: true,
    });

    for (const c of [ALICE, BOB]) {
      await owner.collection("users").create({
        email: c.email,
        password: c.password,
        passwordConfirm: c.password,
        verified: true,
      });
    }

    // a limited (non-Owner) staff member with the sessions write permission
    const role = await owner.roles.create({
      name: "Sessions manager",
      description: "integration",
      permissions: { system: { sessions: "write" } },
    });
    const staff = await owner.collection("_superusers").create({
      email: STAFF.email,
      password: STAFF.password,
      passwordConfirm: STAFF.password,
    });
    await owner.roles.setAssignments("_superusers", staff.id, [role.id]);
  });

  test("signup with prompt=create (hosted signup page, then the flow continues like a login)", async function () {
    const discovery = await raw(url + "/oauth2/users/.well-known/openid-configuration");
    assert.include(discovery.data.prompt_values_supported, "create");

    const superusersDiscovery = await raw(
      url + "/oauth2/_superusers/.well-known/openid-configuration",
    );
    assert.notInclude(superusersDiscovery.data.prompt_values_supported, "create");

    const pb = createAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: new AuthStore(),
      navigate: () => {},
    });

    const signupURL = await pb.account.signupURL({ state: { from: "signup" } });
    assert.equal(new URL(signupURL).searchParams.get("prompt"), "create");

    // the authorize request goes directly to the signup page of the flow
    const first = await fetch(signupURL, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.include(first.headers.get("location") || "", "/oauth2/users/signup?auth_state=");

    const callbackURL = await followHostedFlow(signupURL, REDIRECT, {
      identity: "new.signup@example.com",
      password: "SignupPass12345",
    });

    const result = await pb.account.handleCallback(callbackURL);
    assert.deepEqual(result?.state, { from: "signup" });
    assert.equal(result?.record?.email, "new.signup@example.com");
    assert.isTrue(pb.account.isLoggedIn());

    // the created account can login normally
    const { pb: again } = await accountLogin({
      email: "new.signup@example.com",
      password: "SignupPass12345",
    });
    assert.equal(again.authStore.record?.email, "new.signup@example.com");

    // an issuer without the hosted signup -> invalid_request error redirect
    const dashboard = createAccountClient({
      url,
      collection: "_superusers",
      clientId: "pb_dashboard",
      redirectUri: url + "/_/",
      authStore: new AuthStore(),
      navigate: () => {},
    });
    const denied = await fetch(await dashboard.account.signupURL(), {
      redirect: "manual",
    });
    const location = new URL(denied.headers.get("location") || "", url);
    assert.equal(location.origin + location.pathname, url + "/_/");
    assert.equal(location.searchParams.get("error"), "invalid_request");
    await expect(dashboard.account.handleCallback(location.toString())).rejects.toMatchObject({
      oauth2Error: "invalid_request",
    });
  });

  test("account sessions: list own, cross-record denied, end another browser and the current one", async function () {
    const jarA1 = new CookieJar();
    const { pb: alice1 } = await loginAccountClient(
      {
        url,
        collection: "users",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        identity: ALICE.email,
        password: ALICE.password,
      },
      jarA1,
    );
    const { pb: alice2 } = await accountLogin(ALICE); // another "browser"
    const { pb: bob } = await accountLogin(BOB);

    const items = await alice1.account.sessions.list();

    const sid1 = getTokenPayload(alice1.authStore.token).sid;
    const sid2 = getTokenPayload(alice2.authStore.token).sid;
    const bobSid = getTokenPayload(bob.authStore.token).sid;

    const ids = items.map((i) => i.id);
    assert.include(ids, sid1);
    assert.include(ids, sid2);
    assert.notInclude(ids, bobSid, "never another record sessions");

    const current = items.find((i) => i.id === sid1)!;
    assert.isTrue(current.current);
    assert.equal(current.clientId, CLIENT_ID);
    assert.equal(current.clientName, "Integration accounts");
    assert.isTrue(
      items.some((i) => i.sso && i.current),
      "the current root SSO session",
    );
    assert.isFalse(items.find((i) => i.id === sid2)!.current);

    for (const item of items) {
      for (const secret of ["refreshTokenHash", "ssoSecretHash", "handleHash", "codeHash"]) {
        assert.notProperty(item, secret);
      }
    }

    // another record session can't be ended
    await expect(alice1.account.sessions.end(bobSid)).rejects.toMatchObject({
      status: 404,
    });
    assert.equal((await bob.account.me()).kind, "customer");

    // end the other browser (its root SSO session -> its client session too)
    const other = items.find((i) => i.id === sid2)!;
    assert.isTrue(await alice1.account.sessions.end(other.parent));
    const otherMe = await raw(url + "/api/permissions/me", {
      headers: { Authorization: alice2.authStore.token },
    });
    assert.equal(otherMe.status, 401);
    assert.equal((await alice1.account.me()).kind, "customer", "the current one still works");

    // end the current root SSO session = logout of that browser
    const token = alice1.authStore.token;
    const currentRoot = items.find((i) => i.sso && i.current)!;
    await alice1.account.sessions.end(currentRoot);
    assert.equal(alice1.authStore.token, "", "the local state is cleared");
    const currentMe = await raw(url + "/api/permissions/me", {
      headers: { Authorization: token },
    });
    assert.equal(currentMe.status, 401);

    // the browser SSO cookie no longer signs in silently
    const authorizeURL = await createAccountClient({
      url,
      collection: "users",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      authStore: new AuthStore(),
      navigate: () => {},
    }).account.authorizeURL();
    const silent = await fetch(authorizeURL, {
      redirect: "manual",
      headers: { cookie: jarA1.header() },
    });
    assert.include(silent.headers.get("location") || "", "/oauth2/users/login?");
  });

  test("staff sessions end: a limited staff ends a customer session but not an Owner one", async function () {
    const staff = { pb: await staffClient(url, STAFF.email, STAFF.password) };

    const me = await staff.pb.roles.me();
    assert.equal(me.kind, "staff");
    assert.isFalse(me.owner);

    const { pb: bob } = await accountLogin(BOB);
    const bobSid = getTokenPayload(bob.authStore.token).sid;

    assert.isTrue(await staff.pb.sessions.end(bobSid));
    const bobMe = await raw(url + "/api/permissions/me", {
      headers: { Authorization: bob.authStore.token },
    });
    assert.equal(bobMe.status, 401);

    const ownerSid = getTokenPayload(owner.authStore.token).sid;
    await expect(staff.pb.sessions.end(ownerSid)).rejects.toMatchObject({
      status: 403,
    });
    assert.equal((await owner.roles.me()).owner, true, "the Owner session still works");
  });
});
