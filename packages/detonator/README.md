# pocketbomb-detonator

The PocketBomb Applications framework (like `@shopify/shopify-app-react-router`), on top of the existing server
APIs: install/uninstall notifications, managed webhooks, embedded dashboard extensions and offline admin clients.

```ts
// app/detonator.server.ts
import { detonator } from "pocketbomb-detonator/server";
import { SqliteSessionStorage } from "pocketbomb-detonator/session-storage";

const app = detonator({
  appUrl: process.env.APP_URL!,
  handle: "my-app",
  sessionStorage: new SqliteSessionStorage("detonator.sqlite"),
});

export const { authenticate, unauthenticated } = app;
```

- `authenticate.install(request)`: the install_url/uninstall_url POST (signed `application/jwt`: `typ`, `iss`
  allowed + https unless loopback, issuer JWKS, `aud` = handle, `exp`, single use `jti`) ->
  `application.installed` / `application.credentials_rotated` / `application.uninstalled`.
- `authenticate.webhook(request)`: HMAC (`X-PB-Hmac-Sha256`) with the webhook secret of the installation ->
  `{topic, payload, eventId, installation, admin}`.
- `authenticate.launch(request)`: the dashboard `launch_token` POST in the iframe -> verify (`pb-launch+jwt`, `aud` =
  client_id, single use) -> token exchange -> `redirect()`.
- `authenticate.admin(request)`: the `Bearer` session token (or `id_token` after the bounce) -> verify via JWKS -> online
  session in the storage keyed by (installation, staff session) -> exchange when it is missing or expired. No cookies
  (they are blocked as third party in iframes). A document without a token gets the bounce page (detcord, session
  token, reload with `id_token`, stripped with `history.replaceState`); outside of an iframe a page links back to the dashboard.
- `addDocumentResponseHeaders(request, headers)`: `Content-Security-Policy: frame-ancestors {dashboard origin}` and
  `Referrer-Policy: no-referrer`; `handleEmbeddedRequest(request, {paths})`: the launches + the token checks before the router.
- `authenticate.public.appProxy(request)`: a request forwarded by the app proxy -> verifies the signature over the
  raw query (Shopify algorithm with the webhook secret), `body_sha256` and `timestamp` (±90s) ->
  `{installation, customerId, pathPrefix, admin}`.
- `unauthenticated.admin(issuer?)`: the offline client (client_credentials, re-fetched before it expires).

When the instance rejects the online token, the online admin client deletes the stored session and throws a 401 `Response`
with `X-Detcord-Reauthorize: 1` in that same request (there is no liveness probe; it is detected on actual API use; React Router keeps the thrown status but not
its headers, see `server.ts` of the app template): detcord's fetch patch gets a new token and retries once; if that fails too the dashboard shows a "session ended" state.

The app proxy routes (`/{a|apps|community|tools}/{subpath}/{rest...}`, all methods) are served by an installation only for its
path; any other path falls through to the `GET /{path...}` static route if there is one. NB! A custom server route that overlaps with them
without being more specific or more general (e.g. `/{a}/foo/bar`) makes the server panic at startup (intentionally loud).

Entries: `.` (verifyApplicationJWT, verifyWebhookSignature, createAdminClient, exchangeLaunchToken),
`./server`, `./react` (AppProvider/useApp), `./adapters/node`, `./session-storage` (Memory, `node:sqlite`).

CLI: `detonator dev` (fuse -> import `pocketbomb.app.toml` -> run the app -> install with the manifest scopes),
`detonator deploy --url --token`, `detonator info`.
