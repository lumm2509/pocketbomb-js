import { AuthStore } from "pocketbomb-primer";
import { createDashboardClient, type DashboardClient } from "pocketbomb-primer/internal";
import { followHostedFlow } from "./hosted-flow";

/**
 * Signs in a staff member (e.g. the fuse Owner) with the built-in dashboard OAuth2 client
 * (`_superusers` + `pb_dashboard`) by driving the hosted login page headlessly.
 */
export async function signInStaff(
  url: string,
  email: string,
  password: string,
): Promise<DashboardClient> {
  const redirectUri = url + "/_/";
  const client = createDashboardClient({
    url,
    collection: "_superusers",
    clientId: "pb_dashboard",
    redirectUri,
    authStore: new AuthStore(),
    backgroundRefresh: false,
    navigate: () => {
      throw new Error("unexpected navigation");
    },
  });

  const callbackURL = await followHostedFlow(await client.account.authorizeURL(), redirectUri, {
    identity: email,
    password,
  });
  await client.account.handleCallback(callbackURL);

  return client;
}
