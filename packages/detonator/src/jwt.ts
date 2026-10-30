import { base64Decode, getWebCrypto, toBytes } from "@pocketbomb/primer";

/**
 * The `typ` header of the application extension launch tokens.
 */
export const ApplicationLaunchTokenType = "pb-launch+jwt";

/**
 * The `typ` header of the embedded application session tokens.
 */
export const ApplicationSessionTokenType = "pb-session+jwt";

export interface JSONWebKey {
  [key: string]: any;

  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface VerifyApplicationJWTOptions {
  /**
   * The JWT to verify (install/uninstall notification body or launch token).
   */
  token: string;

  /**
   * The expected issuer (`iss`), e.g. "https://example.com/oauth2/_applicationInstallations".
   */
  issuer: string;

  /**
   * The expected audience (`aud`): the application handle for the notifications,
   * the installation client_id for the launch tokens.
   */
  audience: string;

  /**
   * Optional expected `typ` header (e.g. {@link ApplicationLaunchTokenType}).
   */
  type?: string;

  /**
   * Optional JWKS URL (default to `issuer + "/jwks.json"`).
   */
  jwksURL?: string;

  /**
   * Optional JWKS (skips the fetch).
   */
  jwks?: { keys: Array<JSONWebKey> };

  /**
   * The allowed clock skew in seconds (default to 30).
   */
  clockTolerance?: number;

  /**
   * Optional custom fetch function.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const jwksCacheTTL = 5 * 60 * 1000;

const jwksCache: { [url: string]: { expires: number; keys: Array<JSONWebKey> } } = {};

const algorithms: {
  [alg: string]: { import: any; verify: any };
} = {
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
};

/**
 * JWTVerificationError is thrown by {@link verifyApplicationJWT}.
 */
export class JWTVerificationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, JWTVerificationError.prototype);
    this.name = "JWTVerificationError";
  }
}

/**
 * Clears the in-memory JWKS cache (mostly for tests).
 */
export function clearJWKSCache(): void {
  for (const key in jwksCache) {
    delete jwksCache[key];
  }
}

async function loadJWKS(
  url: string,
  fetchFunc: (url: string, init?: RequestInit) => Promise<Response>,
  force: boolean,
): Promise<Array<JSONWebKey>> {
  const cached = jwksCache[url];
  if (!force && cached && cached.expires > Date.now()) {
    return cached.keys;
  }

  const response = await fetchFunc(url, { method: "GET" });
  if (!response.ok) {
    throw new JWTVerificationError(
      "Failed to fetch the issuer JWKS (status " + response.status + ").",
    );
  }

  const data = await response.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];

  jwksCache[url] = { expires: Date.now() + jwksCacheTTL, keys };

  return keys;
}

function decodeJSONSegment(segment: string, name: string): { [key: string]: any } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Decode(segment)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new JWTVerificationError("Invalid JWT " + name + ".");
  }
}

/**
 * Verifies a JWT signed by a PocketBomb OAuth2 issuer (RS256 or ES256) with the
 * issuer JWKS and returns its claims, e.g. the application install/uninstall
 * notifications (`aud` = the application handle) and the extension launch tokens
 * (`aud` = the installation client_id, `type: "pb-launch+jwt"`).
 *
 * The `iss`, `aud`, `exp`, `nbf` and `iat` claims are checked.
 * The JWKS is cached in memory for 5 minutes (and reloaded once for an unknown `kid`).
 *
 * @throws {JWTVerificationError}
 */
export async function verifyApplicationJWT(
  options: VerifyApplicationJWTOptions,
): Promise<{ [key: string]: any }> {
  const parts = (options.token || "").split(".");
  if (parts.length !== 3) {
    throw new JWTVerificationError("Invalid JWT format.");
  }

  const header = decodeJSONSegment(parts[0], "header");
  const claims = decodeJSONSegment(parts[1], "payload");

  const algorithm = algorithms[header.alg];
  if (!algorithm) {
    throw new JWTVerificationError("Unsupported JWT alg " + header.alg + ".");
  }

  if (options.type && header.typ !== options.type) {
    throw new JWTVerificationError("Unexpected JWT typ " + header.typ + ".");
  }

  // load the matching key
  const fetchFunc = options.fetch || ((url: string, init?: RequestInit) => fetch(url, init));
  const jwksURL = options.jwksURL || options.issuer.replace(/\/+$/, "") + "/jwks.json";

  const findKey = (keys: Array<JSONWebKey>) =>
    keys.find(
      (k) =>
        (!header.kid || k.kid === header.kid) &&
        (!k.alg || k.alg === header.alg) &&
        (!k.use || k.use === "sig"),
    );

  let key: JSONWebKey | undefined;
  if (options.jwks) {
    key = findKey(options.jwks.keys || []);
  } else {
    key = findKey(await loadJWKS(jwksURL, fetchFunc, false));
    if (!key) {
      key = findKey(await loadJWKS(jwksURL, fetchFunc, true));
    }
  }

  if (!key) {
    throw new JWTVerificationError("No matching JWKS key for kid " + header.kid + ".");
  }

  // verify the signature
  const subtle = getWebCrypto().subtle;

  const jwk = Object.assign({}, key);
  delete jwk.key_ops;
  delete jwk.use;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await subtle.importKey("jwk", jwk as JsonWebKey, algorithm.import, false, [
      "verify",
    ]);
  } catch {
    throw new JWTVerificationError("Failed to import the JWKS key.");
  }

  let signature: Uint8Array;
  try {
    signature = base64Decode(parts[2]);
  } catch {
    throw new JWTVerificationError("Invalid JWT signature encoding.");
  }

  const valid = await subtle.verify(
    algorithm.verify,
    cryptoKey,
    signature as BufferSource,
    toBytes(parts[0] + "." + parts[1]) as BufferSource,
  );
  if (!valid) {
    throw new JWTVerificationError("Invalid JWT signature.");
  }

  // validate the claims
  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance ?? 30;

  if (claims.iss !== options.issuer) {
    throw new JWTVerificationError("Unexpected JWT issuer " + claims.iss + ".");
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!options.audience || !aud.includes(options.audience)) {
    throw new JWTVerificationError("Unexpected JWT audience.");
  }

  if (typeof claims.exp !== "number" || claims.exp + tolerance < now) {
    throw new JWTVerificationError("The JWT is expired.");
  }

  if (typeof claims.nbf === "number" && claims.nbf - tolerance > now) {
    throw new JWTVerificationError("The JWT is not valid yet.");
  }

  if (typeof claims.iat === "number" && claims.iat - tolerance > now) {
    throw new JWTVerificationError("The JWT is issued in the future.");
  }

  return claims;
}
