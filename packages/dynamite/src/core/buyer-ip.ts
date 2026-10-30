/**
 * The request headers checked (in order) for the end-user IP by {@link getBuyerIp}
 * when no explicit header is configured.
 *
 * NB! These headers can be spoofed by the clients unless your hosting platform/proxy
 * overwrites them: configure the single header your platform sets (`buyerIpHeader`)
 * or pass the IP explicitly (`buyerIp`) whenever possible.
 */
export const DEFAULT_BUYER_IP_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "fly-client-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

export interface BuyerIpOptions {
  /**
   * The request header set by your platform/proxy with the end-user IP
   * (e.g. "cf-connecting-ip"; for "x-forwarded-for" the first address is used).
   */
  buyerIpHeader?: string;
}

/**
 * Returns the end-user IP of the request (the `X-PB-Buyer-IP` of the private key requests)
 * from the configured header or the first of {@link DEFAULT_BUYER_IP_HEADERS}
 * (an empty string if none is set).
 */
export function getBuyerIp(
  request: { headers: Pick<Headers, "get"> },
  options: BuyerIpOptions = {},
): string {
  const headers = options.buyerIpHeader ? [options.buyerIpHeader] : DEFAULT_BUYER_IP_HEADERS;

  for (const name of headers) {
    const value = request.headers.get(name);
    if (!value) {
      continue;
    }

    // e.g. "x-forwarded-for: client, proxy1, proxy2"
    const ip = value.split(",")[0].trim();
    if (ip) {
      return ip;
    }
  }

  return "";
}
