import { describe, assert, test } from "vitest";
import { randomString, sha256Base64URL, base64Decode } from "../tools/crypto";
import { basicAuthHeader, expiresInToTimestamp, oauth2IssuerPath } from "./oauth2";

describe("oauth2 tools", function () {
  test("sha256Base64URL() should match the RFC 7636 appendix B PKCE vector", async function () {
    assert.equal(
      await sha256Base64URL("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("randomString() should return alphanumeric strings with the requested length", function () {
    const a = randomString(64);
    const b = randomString(64);

    assert.equal(a.length, 64);
    assert.match(a, /^[a-zA-Z0-9]+$/);
    assert.notEqual(a, b);
  });

  test("basicAuthHeader() should form-urlencode the credentials (RFC 6749 section 2.3.1)", function () {
    const header = basicAuthHeader("my client", "s:e/c+r%t");

    assert.isTrue(header.startsWith("Basic "));

    const decoded = new TextDecoder().decode(base64Decode(header.substring(6)));
    assert.equal(decoded, "my+client:s%3Ae%2Fc%2Br%25t");
  });

  test("oauth2IssuerPath() should encode the collection", function () {
    assert.equal(oauth2IssuerPath("users"), "/oauth2/users");
    assert.equal(oauth2IssuerPath("a b"), "/oauth2/a%20b");
  });

  test("expiresInToTimestamp()", function () {
    assert.isUndefined(expiresInToTimestamp(0));
    assert.isUndefined(expiresInToTimestamp(undefined));

    const ts = expiresInToTimestamp(100)!;
    assert.closeTo(ts, Math.floor(Date.now() / 1000) + 100, 2);
  });
});
