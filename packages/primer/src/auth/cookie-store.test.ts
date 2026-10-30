import { describe, assert, test } from "vitest";
import { CookieAuthStore } from "./cookie-store";
import { AuthStore } from "./store";
import { cookieParse } from "../tools/cookie";
import { dummyJWT } from "../test-utils/mocks";

describe("CookieAuthStore", function () {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = dummyJWT({ id: "r1", type: "auth", exp });

  function cookieFromSetCookie(setCookie: string): string {
    return setCookie.split(";")[0];
  }

  test("Should load the auth state and the metadata from the request cookie", function () {
    const source = new AuthStore();
    source.save(token, { id: "r1" } as any, { refreshToken: "rt1", idToken: "it1" });
    const cookie = cookieFromSetCookie(source.exportToCookie({}, "pb_auth"));

    const request = new Request("http://example.com", { headers: { cookie } });
    const store = new CookieAuthStore({ request });

    assert.equal(store.token, token);
    assert.equal(store.record?.id, "r1");
    assert.equal(store.refreshToken, "rt1");
    assert.equal(store.idToken, "it1");
    assert.isFalse(store.isDirty);
    assert.deepEqual(store.commit(), []);
  });

  test("Should commit the changed state as Set-Cookie values", function () {
    const store = new CookieAuthStore({ request: "" });

    store.save(token, { id: "r1" } as any, { refreshToken: "rt1" });
    assert.isTrue(store.isDirty);

    const cookies = store.commit();
    assert.equal(cookies.length, 1);
    assert.include(cookies[0], "pb_auth=");
    assert.include(cookies[0], "HttpOnly");
    // a session cookie because the refresh token outlives the access token
    assert.notInclude(cookies[0], "Expires=");

    // load it back
    const loaded = new CookieAuthStore({ request: cookieFromSetCookie(cookies[0]) });
    assert.equal(loaded.token, token);
    assert.equal(loaded.refreshToken, "rt1");

    // cleared state -> expired cookie
    loaded.clear();
    const cleared = loaded.commit();
    assert.equal(cleared.length, 1);
    assert.include(cleared[0], "Max-Age=0");
  });

  test("Should store the account login flow values in a separate Lax cookie", function () {
    const store = new CookieAuthStore();

    store.set("flow", { state: "abc" });
    assert.deepEqual(store.get("flow"), { state: "abc" });

    const cookies = store.commit();
    assert.equal(cookies.length, 1);
    assert.include(cookies[0], "pb_auth_flow=");
    assert.include(cookies[0], "SameSite=Lax");
    assert.include(cookies[0], "Max-Age=600");

    const loaded = new CookieAuthStore({ request: cookieFromSetCookie(cookies[0]) });
    assert.deepEqual(loaded.get("flow"), { state: "abc" });

    loaded.unset("flow");
    const removed = loaded.commit();
    assert.include(removed[0], "Max-Age=0");
  });

  test("Should apply the encode/decode hooks", function () {
    const encode = (v: string) => "enc:" + btoa(v);
    const decode = (v: string) => (v.startsWith("enc:") ? atob(v.substring(4)) : "");

    const store = new CookieAuthStore({ encode, decode });
    store.save(token, null, {});
    const cookie = cookieFromSetCookie(store.commit()[0]);

    assert.isTrue(cookieParse(cookie)["pb_auth"].startsWith("enc:"));

    const loaded = new CookieAuthStore({ request: cookie, encode, decode });
    assert.equal(loaded.token, token);

    // tampered/unknown value -> empty state
    const tampered = new CookieAuthStore({ request: "pb_auth=xyz", encode, decode });
    assert.equal(tampered.token, "");
  });
});
