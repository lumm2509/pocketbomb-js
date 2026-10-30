// The app PocketBomb setup, without React Native imports so that it also runs in Node.js
// (see src/smoke.ts): the storage and the in-app auth session are injected adapters.
import { createStorefrontClient, flattenConnection, gql } from "pocketbomb-dynamite";
import { createCustomerAccountClient } from "pocketbomb-dynamite/customer-account";
import {
  AsyncAuthStore,
  MemoryLoginSession,
  type AsyncKeyValueStorage,
  type OpenAuthSession,
} from "pocketbomb-primer";

export interface ShopConfig {
  url: string;
  publicKey: string;
  clientId: string;
  redirectUri: string;

  /** An AsyncStorage-like storage (`@react-native-async-storage/async-storage`). */
  storage: AsyncKeyValueStorage;

  /** The in-app auth session (`WebBrowser.openAuthSessionAsync`). */
  openAuthSession: OpenAuthSession;
}

export const PRODUCTS = gql<
  { products: { nodes: Array<{ id: string; title: string }>; totalCount: number } },
  { first: number }
>(
  `query Products($first: Int) { products(first: $first, sort: "handle") { nodes { id title } totalCount } }`,
);

/**
 * Creates the shop clients: the storefront (public key) and the customer account
 * (persisted in the storage; the session is restored and refreshed on startup).
 */
export async function createShop(config: ShopConfig) {
  const authStore = AsyncAuthStore.fromStorage(config.storage, "pocketbomb_shop_auth");
  await authStore.ready;

  const storefront = createStorefrontClient({ url: config.url, publicKey: config.publicKey });

  const customer = createCustomerAccountClient({
    url: config.url,
    collection: "users",
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    publicKey: config.publicKey,
    scopes: ["openid", "email", "offline_access"],
    authStore,
    // the login flow state lives only while the auth session is open
    session: new MemoryLoginSession(),
    openAuthSession: config.openAuthSession,
  });

  await customer.account.restore();

  return {
    storefront,
    customer,
    authStore,
    async products(first = 10) {
      const data = await storefront.query(PRODUCTS, { variables: { first } });
      return flattenConnection(data.products);
    },
  };
}

export type Shop = Awaited<ReturnType<typeof createShop>>;
