# PocketBomb app (React Router v7)

A PocketBomb application starter with `@pocketbomb/detonator` (like the Shopify app template).

- `pocketbomb.app.toml`: scopes, the managed webhook subscriptions, the dashboard extensions (navigation +
  record action) and the install/uninstall URLs
- `app/detonator.server.ts`: the detonator setup (`SqliteSessionStorage` on `node:sqlite`)
- `app/routes/install.tsx`, `uninstall.tsx`: the signed notifications; `webhooks.orders.create.tsx`: the webhook
- `app/root.tsx`: the detcord script (the App Bridge equivalent; the app renders inside the dashboard iframe, there
  are no cookies and no new tab), `server.ts`: the launches and the session token bounce before the router
- `app/routes/app.tsx` (navigation extension), `app.record.tsx` (record action): the online staff session of the
  session token; `app._index.tsx`: staff, grant and records via the online admin client
- `app/routes/proxy.$.tsx`: the public app proxy (`[app_proxy]` of the manifest)

```sh
pnpm dev      # detonator dev: fuse + import the manifest + run the app + install it (open the printed dashboard URL)
pnpm build && pnpm start
pnpm deploy -- --url https://pb.example.com --token <staff token> --app-url https://app.example.com
pnpm test:e2e # Playwright smoke against fuse
```
