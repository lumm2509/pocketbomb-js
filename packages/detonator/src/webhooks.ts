import { base64Decode, getWebCrypto, toBytes } from "@pocketbomb/primer";
import { timingSafeEqual } from "./crypto";

/**
 * The PocketBomb webhook delivery headers.
 */
export const WebhookHeaders = {
  topic: "X-PB-Topic",
  hmac: "X-PB-Hmac-Sha256",
  webhookId: "X-PB-Webhook-Id",
  eventId: "X-PB-Event-Id",
  triggeredAt: "X-PB-Triggered-At",
  apiVersion: "X-PB-Api-Version",
  test: "X-PB-Test",
  /** The application installation id of a managed (application installation) webhook. */
  applicationInstallation: "X-PB-Application-Installation",
  /** The `_applicationInstallations` issuer of a managed webhook. */
  issuer: "X-PB-Issuer",
} as const;

export type HeadersLike =
  | { get(name: string): string | null }
  | { [key: string]: string | Array<string> | undefined };

export interface VerifyWebhookSignatureOptions {
  /**
   * The webhook subscription (or application installation) signing secret.
   */
  secret: string;

  /**
   * The raw (unparsed) request body.
   */
  body: string | ArrayBuffer | ArrayBufferView;

  /**
   * The request headers (a Fetch `Headers` instance or a plain Node.js headers object).
   */
  headers?: HeadersLike;

  /**
   * Optional explicit signature (default to the `X-PB-Hmac-Sha256` header value).
   */
  signature?: string;
}

/**
 * Returns the case-insensitive header value from a Fetch `Headers`-like
 * object or a plain (e.g. Node.js `IncomingHttpHeaders`) object.
 */
export function getHeaderValue(headers: HeadersLike | undefined, name: string): string {
  if (!headers) {
    return "";
  }

  if (typeof (headers as any).get === "function") {
    return (headers as any).get(name) || "";
  }

  const lower = name.toLowerCase();
  for (const key in headers) {
    if (key.toLowerCase() === lower) {
      const value = (headers as any)[key];
      return Array.isArray(value) ? value[0] || "" : value || "";
    }
  }

  return "";
}

/**
 * Computes the base64 encoded HMAC-SHA256 signature of the raw body
 * (the same as the PocketBomb Go `webhooks.Sign`).
 */
export async function signWebhookBody(
  body: string | ArrayBuffer | ArrayBufferView,
  secret: string,
): Promise<string> {
  const raw = await hmacSHA256(toBytes(body), secret);

  let binary = "";
  for (const b of raw) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary);
}

/**
 * Verifies the `X-PB-Hmac-Sha256` signature of a PocketBomb webhook delivery
 * (base64 HMAC-SHA256 of the raw body with the webhook secret; constant-time comparison).
 *
 * Works with any WebCrypto runtime (Node.js >= 18, Deno, Bun, edge workers).
 * Receivers should also dedupe the deliveries by the `X-PB-Event-Id` header (at-least-once).
 *
 * Example:
 *
 * ```js
 * const body = await request.text(); // the raw body, before JSON.parse
 * if (!(await verifyWebhookSignature({ secret, body, headers: request.headers }))) {
 *     return new Response("invalid signature", { status: 401 });
 * }
 * ```
 */
export async function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): Promise<boolean> {
  const signature = (
    options.signature ?? getHeaderValue(options.headers, WebhookHeaders.hmac)
  ).trim();

  if (!options.secret || !signature) {
    return false;
  }

  let provided: Uint8Array;
  try {
    provided = base64Decode(signature);
  } catch {
    return false;
  }

  const expected = await hmacSHA256(toBytes(options.body), options.secret);

  return timingSafeEqual(expected, provided);
}

async function hmacSHA256(data: Uint8Array, secret: string): Promise<Uint8Array> {
  const subtle = getWebCrypto().subtle;

  const key = await subtle.importKey(
    "raw",
    toBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(await subtle.sign("HMAC", key, data as BufferSource));
}
