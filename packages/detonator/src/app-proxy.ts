import { getWebCrypto, toBytes } from "pocketbomb-primer";
import { timingSafeEqual } from "./crypto";

/**
 * The allowed difference between the app proxy `timestamp` and the local clock (in seconds).
 */
export const AppProxyTimestampWindow = 90;

export interface VerifyAppProxySignatureOptions {
  /**
   * The installation webhook secret.
   */
  secret: string;

  /**
   * The raw query of the request (the empty params are part of the signature).
   */
  query: URLSearchParams;

  /**
   * The raw request body (empty for the requests without a body).
   */
  body?: ArrayBuffer | ArrayBufferView;

  /**
   * The current unix time in seconds (default to the local clock).
   */
  now?: number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns the hex sha256 of the provided bytes (the `body_sha256` param).
 */
export async function sha256Hex(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  return hex(new Uint8Array(await getWebCrypto().subtle.digest("SHA-256", data as BufferSource)));
}

function compareUTF8(a: string, b: string): number {
  const left = toBytes(a);
  const right = toBytes(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return left.length - right.length;
}

/**
 * Returns the hex HMAC-SHA256 of the query (Shopify's App Proxy algorithm, the same as the
 * PocketBomb Go `core.ApplicationProxySignature`): the params except `signature` sorted by name,
 * `k=v` concatenated without separators and the multiple values of a param joined with ",".
 */
export async function signAppProxyQuery(query: URLSearchParams, secret: string): Promise<string> {
  const message = Array.from(new Set(query.keys()))
    .filter((k) => k !== "signature")
    .toSorted(compareUTF8)
    .map((k) => k + "=" + query.getAll(k).join(","))
    .join("");

  const subtle = getWebCrypto().subtle;
  const key = await subtle.importKey(
    "raw",
    toBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return hex(new Uint8Array(await subtle.sign("HMAC", key, toBytes(message) as BufferSource)));
}

/**
 * Verifies a request forwarded by the PocketBomb app proxy: the `signature` over the raw query
 * (constant-time comparison), the `timestamp` window (replays) and the `body_sha256` of the raw body.
 */
export async function verifyAppProxySignature(
  options: VerifyAppProxySignatureOptions,
): Promise<boolean> {
  const { query, secret } = options;
  const signature = query.get("signature") || "";

  if (!secret || !signature) {
    return false;
  }

  const expected = await signAppProxyQuery(query, secret);
  if (!timingSafeEqual(toBytes(expected), toBytes(signature))) {
    return false;
  }

  const timestamp = Number(query.get("timestamp"));
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > AppProxyTimestampWindow) {
    return false;
  }

  const body = options.body ?? new ArrayBuffer(0);

  return (await sha256Hex(body)) === query.get("body_sha256");
}
