import { describe, assert, test, beforeAll, afterEach } from "vitest";
import {
  ApplicationLaunchTokenType,
  clearJWKSCache,
  JWTVerificationError,
  verifyApplicationJWT,
} from "./jwt";
import { base64URLEncode } from "@pocketbomb/primer";

const issuer = "https://example.com/oauth2/_applicationInstallations";

type TestKey = { jwk: any; privateKey: CryptoKey; alg: string; kid: string };

async function generateKey(alg: "RS256" | "ES256", kid: string): Promise<TestKey> {
  const params =
    alg === "RS256"
      ? {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        }
      : { name: "ECDSA", namedCurve: "P-256" };

  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;

  const jwk: any = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = kid;
  jwk.alg = alg;
  jwk.use = "sig";

  return { jwk, privateKey: pair.privateKey, alg, kid };
}

async function signJWT(
  key: TestKey,
  claims: { [key: string]: any },
  header: { [key: string]: any } = {},
): Promise<string> {
  const enc = (v: any) => base64URLEncode(new TextEncoder().encode(JSON.stringify(v)));

  const input = enc(Object.assign({ alg: key.alg, kid: key.kid }, header)) + "." + enc(claims);

  const signature = await crypto.subtle.sign(
    key.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(input),
  );

  return input + "." + base64URLEncode(new Uint8Array(signature));
}

function baseClaims(extra: { [key: string]: any } = {}) {
  const now = Math.floor(Date.now() / 1000);

  return Object.assign(
    {
      iss: issuer,
      aud: "my-app",
      iat: now,
      exp: now + 300,
      jti: "abc",
      event: "application.installed",
    },
    extra,
  );
}

async function expectError(promise: Promise<any>, contains: string) {
  try {
    await promise;
  } catch (err: any) {
    assert.instanceOf(err, JWTVerificationError);
    assert.include(err.message, contains);
    return;
  }
  assert.fail("Expected JWTVerificationError containing " + contains);
}

describe("verifyApplicationJWT()", function () {
  let rsa: TestKey;
  let ec: TestKey;
  let other: TestKey;

  beforeAll(async function () {
    rsa = await generateKey("RS256", "rsa1");
    ec = await generateKey("ES256", "ec1");
    other = await generateKey("RS256", "rsa1"); // same kid, different key
  });

  afterEach(function () {
    clearJWKSCache();
  });

  test("Should verify a RS256 install notification", async function () {
    const token = await signJWT(rsa, baseClaims());

    const claims = await verifyApplicationJWT({
      token,
      issuer,
      audience: "my-app",
      jwks: { keys: [ec.jwk, rsa.jwk] },
    });

    assert.equal(claims.event, "application.installed");
  });

  test("Should verify a ES256 launch token with typ", async function () {
    const token = await signJWT(ec, baseClaims({ aud: "client_1", sub: "staff1" }), {
      typ: ApplicationLaunchTokenType,
    });

    const claims = await verifyApplicationJWT({
      token,
      issuer,
      audience: "client_1",
      type: ApplicationLaunchTokenType,
      jwks: { keys: [rsa.jwk, ec.jwk] },
    });

    assert.equal(claims.sub, "staff1");
  });

  test("Should reject invalid tokens", async function () {
    const jwks = { keys: [rsa.jwk] };

    await expectError(
      verifyApplicationJWT({ token: "a.b", issuer, audience: "my-app", jwks }),
      "format",
    );

    // signed with another key with the same kid
    await expectError(
      verifyApplicationJWT({
        token: await signJWT(other, baseClaims()),
        issuer,
        audience: "my-app",
        jwks,
      }),
      "signature",
    );

    // tampered payload
    const valid = await signJWT(rsa, baseClaims());
    const parts = valid.split(".");
    parts[1] = base64URLEncode(
      new TextEncoder().encode(JSON.stringify(baseClaims({ aud: "evil" }))),
    );
    await expectError(
      verifyApplicationJWT({
        token: parts.join("."),
        issuer,
        audience: "evil",
        jwks,
      }),
      "signature",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(rsa, baseClaims()),
        issuer,
        audience: "other-app",
        jwks,
      }),
      "audience",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(rsa, baseClaims({ iss: "https://evil.com" })),
        issuer,
        audience: "my-app",
        jwks,
      }),
      "issuer",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(rsa, baseClaims({ exp: Date.now() / 1000 - 100 })),
        issuer,
        audience: "my-app",
        jwks,
      }),
      "expired",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(rsa, baseClaims(), { typ: "JWT" }),
        issuer,
        audience: "my-app",
        type: ApplicationLaunchTokenType,
        jwks,
      }),
      "typ",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(rsa, baseClaims(), { alg: "HS256" }),
        issuer,
        audience: "my-app",
        jwks,
      }),
      "alg",
    );

    await expectError(
      verifyApplicationJWT({
        token: await signJWT(ec, baseClaims()),
        issuer,
        audience: "my-app",
        jwks,
      }),
      "No matching",
    );
  });

  test("Should fetch the issuer JWKS (cached, reloaded once for an unknown kid)", async function () {
    const urls: Array<string> = [];
    let keys = [rsa.jwk];

    const fetchFunc = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ keys }), { status: 200 });
    };

    const token = await signJWT(rsa, baseClaims());
    await verifyApplicationJWT({
      token,
      issuer,
      audience: "my-app",
      fetch: fetchFunc,
    });
    await verifyApplicationJWT({
      token,
      issuer,
      audience: "my-app",
      fetch: fetchFunc,
    });

    assert.deepEqual(urls, [issuer + "/jwks.json"]);

    // rotated key -> one forced reload
    keys = [rsa.jwk, ec.jwk];
    await verifyApplicationJWT({
      token: await signJWT(ec, baseClaims()),
      issuer,
      audience: "my-app",
      fetch: fetchFunc,
    });

    assert.equal(urls.length, 2);
  });
});
