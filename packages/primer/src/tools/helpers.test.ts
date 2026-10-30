import { afterEach, assert, describe, expect, test } from "vitest";
import { Client } from "../client";
import { withCrossTabLock, withLeaseLock } from "../auth/locks";
import { OAuth2GrantType, OAuth2TokenType, oauth2FormRequest } from "../auth/oauth2";
import { oauth2Error } from "../auth/account";
import { authTokenMetaKeys, extractAuthTokenMeta } from "../auth/store";
import { base64Decode, base64Encode, base64URLEncode, getWebCrypto, toBytes } from "./crypto";
import { normalizeUnknownQueryParams } from "./options";

describe("crypto", function () {
  test("base64Encode() / base64URLEncode() / base64Decode()", function () {
    const bytes = new Uint8Array([251, 255, 191, 0, 1]);
    assert.equal(base64Encode(bytes), "+/+/AAE=");
    assert.equal(base64URLEncode(bytes), "-_-_AAE");
    assert.deepEqual(base64Decode("-_-_AAE"), bytes);
    assert.deepEqual(base64Decode(" +/+/AAE= "), bytes);
    assert.throws(() => base64Decode("@@@"));
  });

  test("toBytes()", function () {
    assert.deepEqual(toBytes("é"), new Uint8Array([195, 169]));
    assert.deepEqual(toBytes(new Uint8Array([1, 2]).buffer), new Uint8Array([1, 2]));
    const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
    assert.deepEqual(toBytes(view), new Uint8Array([8, 7]));
    assert.deepEqual(toBytes(new DataView(new Uint8Array([5, 4]).buffer)), new Uint8Array([5, 4]));
  });

  test("getWebCrypto() returns the global WebCrypto or throws", function () {
    assert.equal(getWebCrypto(), globalThis.crypto);

    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      assert.throws(() => getWebCrypto(), /WebCrypto is not available/);
    } finally {
      Object.defineProperty(globalThis, "crypto", original);
    }
  });
});

describe("options", function () {
  test("normalizeUnknownQueryParams() moves the unknown send options to the query", function () {
    const options: any = {
      method: "GET",
      headers: { a: "1" },
      requestKey: "k",
      skipAuth: true,
      filter: "x=1",
      query: { page: 2 },
    };
    normalizeUnknownQueryParams(options);

    assert.deepEqual(options, {
      method: "GET",
      headers: { a: "1" },
      requestKey: "k",
      skipAuth: true,
      query: { page: 2, filter: "x=1" },
    });

    normalizeUnknownQueryParams(undefined); // no-op
  });
});

describe("auth store meta", function () {
  test("extractAuthTokenMeta() keeps only the known non-empty keys", function () {
    assert.deepEqual(authTokenMetaKeys, [
      "refreshToken",
      "idToken",
      "expiresAt",
      "scope",
      "clientId",
      "associatedUser",
    ]);
    assert.deepEqual(
      extractAuthTokenMeta({
        refreshToken: "rt",
        idToken: "",
        expiresAt: 10,
        scope: null,
        clientId: "c",
        token: "t",
        other: 1,
      }),
      { refreshToken: "rt", expiresAt: 10, clientId: "c" },
    );
    assert.deepEqual(extractAuthTokenMeta(null), {});
    assert.deepEqual(extractAuthTokenMeta("x" as any), {});
  });
});

describe("oauth2", function () {
  function recordingClient() {
    const requests: Array<{ url: string; init: any }> = [];
    const client = new Client("http://test.local", {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      },
    });
    client.authStore.save("stored_token", null);
    return { client, requests };
  }

  test("oauth2FormRequest() public client: client_id body param, no stored token, no empty values", async function () {
    const { client, requests } = recordingClient();

    const result = await oauth2FormRequest(
      client,
      "/oauth2/users/token",
      { grant_type: OAuth2GrantType.refreshToken, refresh_token: "rt", scope: "", empty: null },
      { clientId: "app" },
    );

    assert.deepEqual(result, { access_token: "a" });
    assert.equal(requests[0].url, "http://test.local/oauth2/users/token");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.isUndefined(requests[0].init.headers["Authorization"]);
    assert.equal(requests[0].init.body, "grant_type=refresh_token&refresh_token=rt&client_id=app");
  });

  test("oauth2FormRequest() confidential client: client_secret_basic", async function () {
    const { client, requests } = recordingClient();

    await oauth2FormRequest(
      client,
      "/oauth2/users/token",
      { grant_type: OAuth2GrantType.clientCredentials },
      { clientId: "app", clientSecret: "secret" },
    );

    assert.equal(requests[0].init.headers["Authorization"], "Basic " + btoa("app:secret"));
    assert.equal(requests[0].init.body, "grant_type=client_credentials");
  });

  test("oauth2FormRequest() throws the OAuth2 errors", async function () {
    const client = new Client("http://test.local", {
      fetch: async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Nope" }), {
          status: 400,
        }),
    });

    await expect(oauth2FormRequest(client, "/oauth2/users/token", {})).rejects.toMatchObject({
      status: 400,
      oauth2Error: "invalid_grant",
      message: "Nope",
    });
  });

  test("oauth2Error() and the token type constants", function () {
    const err = oauth2Error("invalid_state", "Bad state");
    assert.equal(err.status, 400);
    assert.equal(err.oauth2Error, "invalid_state");
    assert.equal(err.oauth2ErrorDescription, "Bad state");
    assert.equal(OAuth2TokenType.accessToken, "urn:ietf:params:oauth:token-type:access_token");
    assert.equal(OAuth2TokenType.recordId, "urn:pocketbase:params:oauth:token-type:record_id");
    assert.equal(
      OAuth2TokenType.launchToken,
      "urn:pocketbase:params:oauth:token-type:launch_token",
    );
  });
});

describe("locks", function () {
  afterEach(function () {
    delete (globalThis as any).window;
    delete (globalThis as any).__locksNavigator;
  });

  test("withCrossTabLock() runs the callback directly outside of browsers", async function () {
    assert.equal(await withCrossTabLock("x", async () => 42), 42);
  });

  test("withCrossTabLock() uses navigator.locks when available", async function () {
    const calls: Array<[string, any]> = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: (name: string, options: any, fn: () => Promise<any>) => {
            calls.push([name, options]);
            return fn();
          },
        },
      },
    });
    try {
      assert.equal(await withCrossTabLock("my_lock", async () => "ok"), "ok");
      assert.deepEqual(calls, [["my_lock", { mode: "exclusive" }]]);
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "navigator", original);
      } else {
        delete (globalThis as any).navigator;
      }
    }
  });

  test("withLeaseLock() serializes the callbacks with a localStorage lease", async function () {
    const data = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
        removeItem: (k: string) => data.delete(k),
      },
    };

    const events: Array<string> = [];
    const task = (name: string) => async () => {
      events.push(name + ":start");
      assert.isTrue(data.has("lease"), "the lease is held while running");
      await Promise.resolve();
      events.push(name + ":end");
      return name;
    };

    const results = await Promise.all([
      withLeaseLock("lease", task("a")),
      withLeaseLock("lease", task("b")),
    ]);

    assert.deepEqual(results.toSorted(), ["a", "b"]);
    // the two callbacks never overlap
    assert.match(events.join(","), /^(a:start,a:end,b:start,b:end|b:start,b:end,a:start,a:end)$/);
    assert.isFalse(data.has("lease"), "the lease is released");
  });

  test("withLeaseLock() takes over an expired lease and runs without storage", async function () {
    const data = new Map<string, string>([
      ["lease", JSON.stringify({ owner: "closed-tab", expires: Date.now() - 1 })],
    ]);
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
        removeItem: (k: string) => data.delete(k),
      },
    };
    assert.equal(await withLeaseLock("lease", async () => "taken"), "taken");
    assert.isFalse(data.has("lease"));

    delete (globalThis as any).window;
    assert.equal(await withLeaseLock("lease", async () => "direct"), "direct");
  });
});
