// Test helpers: a signing key + JWKS and a signed JWT (like the PocketBomb issuer).
import { base64URLEncode } from "@pocketbomb/primer";

export type TestKey = { jwk: any; privateKey: CryptoKey; alg: string; kid: string };

export async function generateKey(alg: "RS256" | "ES256", kid: string): Promise<TestKey> {
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

export async function signJWT(
  key: TestKey,
  claims: Record<string, any>,
  header: Record<string, any> = {},
): Promise<string> {
  const enc = (v: any) => base64URLEncode(new TextEncoder().encode(JSON.stringify(v)));
  const input = enc({ alg: key.alg, kid: key.kid, ...header }) + "." + enc(claims);

  const signature = await crypto.subtle.sign(
    key.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(input),
  );

  return input + "." + base64URLEncode(new Uint8Array(signature));
}
