# @pocketbomb/primer

The PocketBomb transport (browser, Node.js, edge, React Native; fetch + WebCrypto only).

```ts
import { createPublicClient, createAccountClient, AsyncAuthStore } from "@pocketbomb/primer";

// storefront (public key; browser/mobile safe)
const storefront = createPublicClient({ url, publicKey: "pb_pk_..." });
await storefront.collection("products").getList(1, 20);
await storefront.graphql(`{ products(first: 10) { nodes { id title } } }`);

// server (private key + the end-user IP; refuses to run in a browser)
const server = createPublicClient({ url, privateKey: "pb_sk_...", buyerIp });

// customer account (hosted OAuth2 login, PKCE, refresh rotation, logout)
const shop = createAccountClient({ url, collection: "users", clientId, redirectUri });
await shop.account.login(); // browser redirect
await shop.account.handleCallback(); // on the redirect URI

// mobile: AsyncStorage + in-app auth session
const mobile = createAccountClient({
  url, collection: "users", clientId, redirectUri: "myapp://auth/callback",
  authStore: AsyncAuthStore.fromStorage(AsyncStorage),
  openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
});
await mobile.account.login();
```

Entries: `@pocketbomb/primer` (public) and `@pocketbomb/primer/internal` (the PocketBomb dashboard
internal services: not a public API).

Ported from the enriched PocketBase JS SDK (MIT, Gani Georgiev), see LICENSE.md.
