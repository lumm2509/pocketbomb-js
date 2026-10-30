// Minimal WebCrypto helpers (browsers, Node.js >= 18, Deno, Bun and the edge runtimes).

const alphanumeric = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Returns the global WebCrypto implementation or throws if it is not available.
 */
export function getWebCrypto(): Crypto {
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (!c?.getRandomValues || !c?.subtle) {
    throw new Error(
      "WebCrypto is not available in the current environment (globalThis.crypto.subtle).",
    );
  }

  return c;
}

/**
 * Generates a cryptographically random alphanumeric string with the specified length.
 */
export function randomString(length: number): string {
  // note: 248 is the largest multiple of 62 below 256 (avoids the modulo bias)
  const result: Array<string> = [];
  const bytes = new Uint8Array(length * 2);

  while (result.length < length) {
    getWebCrypto().getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 248 && result.length < length) {
        result.push(alphanumeric[b % 62]);
      }
    }
  }

  return result.join("");
}

/**
 * Encodes the provided bytes as base64url string without padding (RFC 4648 section 5).
 */
export function base64URLEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encodes the provided bytes as standard base64 string (with padding).
 */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary);
}

/**
 * Decodes a base64 or base64url (with or without padding) string.
 *
 * @throws {Error} on invalid input
 */
export function base64Decode(value: string): Uint8Array {
  let normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) {
    normalized += "=";
  }

  const binary = atob(normalized);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    result[i] = binary.charCodeAt(i);
  }

  return result;
}

/**
 * Converts the provided value to bytes (strings are UTF-8 encoded).
 */
export function toBytes(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Returns the base64url encoded SHA-256 digest of the provided value
 * (e.g. the PKCE S256 code challenge of a code verifier).
 */
export async function sha256Base64URL(value: string): Promise<string> {
  const digest = await getWebCrypto().subtle.digest("SHA-256", toBytes(value) as BufferSource);

  return base64URLEncode(new Uint8Array(digest));
}
