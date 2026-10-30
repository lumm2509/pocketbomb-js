# PocketBomb storefront (React Router v7)

Server rendered storefront with `pocketbomb-dynamite`: catalog (GraphQL), paginated list (URL cursors),
product pages, browser search (public key), customer account (hosted login/signup, own sessions, logout)
with an httpOnly cookie session. `server.ts` creates the request context (buyer IP, session, cache) of every request;
the loaders use the private storefront client.

```sh
pnpm dev        # dynamite dev: fuse (local PocketBomb + fuse.seed.ts) + codegen watcher + server.ts (Vite)
pnpm codegen    # .dynamite/schema.graphql + pocketbomb-env.d.ts (typed graphql() documents)
pnpm build && pnpm start
pnpm test:e2e   # production build + Playwright smoke against fuse + ts-plugin smoke
```

Env: `POCKETBOMB_URL`, `POCKETBOMB_PUBLIC_KEY`, `POCKETBOMB_PRIVATE_KEY` (server-only), `POCKETBOMB_CLIENT_ID`.
