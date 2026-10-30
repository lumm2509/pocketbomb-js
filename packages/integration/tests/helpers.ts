import { AuthStore, createAccountClient, type Client } from "@pocketbomb/primer";
import type { DashboardClient } from "@pocketbomb/primer/internal";
import {
  CookieJar,
  followHostedFlow,
  FUSE_OWNER as OWNER,
  signInStaff,
} from "@pocketbomb/fuse/node";

export { CookieJar, followHostedFlow, OWNER };

/**
 * Creates an account client and signs in headlessly through the hosted login page.
 */
export async function loginAccountClient(
  options: {
    url: string;
    collection: string;
    clientId: string;
    redirectUri: string;
    identity: string;
    password: string;
    publicKey?: string;
    authStore?: AuthStore;
    lockName?: string;
    scopes?: Array<string>;
    navigate?: (url: string) => void;
  },
  jar = new CookieJar(),
): Promise<{ pb: Client; jar: CookieJar }> {
  const pb = createAccountClient({
    url: options.url,
    collection: options.collection,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    publicKey: options.publicKey,
    authStore: options.authStore || new AuthStore(),
    lockName: options.lockName,
    scopes: options.scopes,
    navigate:
      options.navigate ||
      (() => {
        throw new Error("unexpected navigation");
      }),
  });

  const authorizeURL = await pb.account.authorizeURL();
  const callbackURL = await followHostedFlow(
    authorizeURL,
    options.redirectUri,
    { identity: options.identity, password: options.password },
    jar,
  );

  await pb.account.handleCallback(callbackURL);

  return { pb, jar };
}

/**
 * Signs in the CLI created Owner with the built-in dashboard client (pb_dashboard)
 * (a dashboard client with the internal services used by the fixtures).
 */
export async function ownerClient(url: string): Promise<DashboardClient> {
  return staffClient(url, OWNER.email, OWNER.password);
}

/**
 * Signs in a staff member with the built-in dashboard client (pb_dashboard).
 */
export const staffClient = signInStaff;

/**
 * Sends a raw request (without the SDK) and returns the status and the parsed body.
 */
export async function raw(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; data: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch (_) {}
  return { status: response.status, data };
}
