// Node.js runtime smoke test of the app setup (src/shop.ts) against a real PocketBomb server,
// with an AsyncStorage-like in-memory storage and a headless in-app auth session
// (the hosted pages are driven like ASWebAuthenticationSession would).
//
// Usage: pnpm smoke (starts a seeded PocketBomb server, see scripts/pocketbomb-server.ts)
import type { AsyncKeyValueStorage, OpenAuthSession } from "pocketbomb-primer";
import { CookieJar, followHostedFlow } from "pocketbomb-fuse/node";
import { createShop } from "./shop.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(name + " is required (run it with `pnpm smoke`).");
  }
  return value;
};

class MemoryAsyncStorage implements AsyncKeyValueStorage {
  data = new Map<string, string>();
  async getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  async removeItem(key: string) {
    this.data.delete(key);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("smoke assertion failed: " + message);
  }
}

const jar = new CookieJar(); // the in-app browser cookies
const openAuthSession: OpenAuthSession = async (url, redirectUri) => ({
  type: "success",
  url: await followHostedFlow(
    url,
    redirectUri,
    {
      identity: env("POCKETBOMB_CUSTOMER_EMAIL"),
      password: env("POCKETBOMB_CUSTOMER_PASSWORD"),
    },
    jar,
  ),
});

const storage = new MemoryAsyncStorage();
const config = {
  url: env("POCKETBOMB_URL"),
  publicKey: env("POCKETBOMB_PUBLIC_KEY"),
  clientId: env("POCKETBOMB_CLIENT_ID"),
  redirectUri: env("POCKETBOMB_APP_REDIRECT"),
  storage,
  openAuthSession,
};

// app start #1: browse and sign in
const shop = await createShop(config);
const products = await shop.products();
assert(products.length === 3, "3 products");
assert(!shop.customer.isLoggedIn(), "signed out on the first start");

const result = await shop.customer.login();
assert(result?.record?.email === env("POCKETBOMB_CUSTOMER_EMAIL"), "signed in");
await shop.authStore.flush();

// app start #2: the persisted session is restored
const restarted = await createShop(config);
assert(restarted.customer.isLoggedIn(), "restored after restart");
const me = await restarted.customer.me();
assert(me.kind === "customer", "customer permissions");

// sign out
await restarted.customer.logout();
await restarted.authStore.flush();
assert(!storage.data.has("pocketbomb_shop_auth"), "the storage is cleared");

console.log(
  `expo-minimal smoke OK: ${products.length} products, signed in/restored/signed out as ${me.record?.email}`,
);
