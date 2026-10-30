# PocketBomb JS

The JavaScript packages of [PocketBomb](https://github.com/lumm2509/pocketbomb) (pnpm workspaces + turbo).

| Package | What |
|---|---|
| [`pocketbomb-primer`](packages/primer) | The transport shared by every package and by the PocketBomb dashboard: API keys/tokens headers, errors, auth stores (memory, localStorage, cookie, AsyncStorage-like), the OAuth2 account strategy (PKCE, refresh rotation with a cross-tab lock, logout, `openAuthSession` for mobile), records REST, GraphQL, realtime, file URLs. Browser, Node.js, edge and React Native; no runtime dependencies. |
| [`pocketbomb-dynamite`](packages/dynamite) | The storefront framework: `createRequestContext` (buyer IP, httpOnly cookie session, cache), `createStorefrontClient` (public key or private key + buyer IP), `createCustomerAccountClient` (SSR, browser and mobile), gql.tada `graphql()` documents, `./react`, `./vite`, `./ts-plugin` and the `dynamite` CLI (codegen, dev, info). |
| [`pocketbomb-detonator`](packages/detonator) | The PocketBomb Applications framework: install/uninstall notifications (issuer JWKS), managed webhooks (HMAC), dashboard extension launches (online staff sessions), offline admin clients, Memory/`node:sqlite` session storages, `./react`, `./adapters/node` and the `detonator` CLI (dev, deploy, info). |
| [`pocketbomb-fuse`](packages/fuse) | The local dev runtime: builds/locates and runs the PocketBomb server with a temporary data dir, the Owner and a seed (`./node`, `./vite`). |

The PocketBomb API surfaces (Shopify mental model):

- **Storefront API**: records REST (list/view) + `POST /api/graphql` + realtime + files with a public key
  (browser/mobile) or a private key + the buyer IP (server).
- **Customer Account**: the hosted OAuth2/OIDC pages of an auth collection (login, signup, refresh rotation,
  logout, userinfo, consents, own sessions).
- **Applications** (the Admin API counterpart): the installations of an application get offline client credentials
  and online staff tokens (extension launches) on the existing server APIs: `pocketbomb-detonator`.
- The dashboard internals live in `pocketbomb-primer/internal` (used by the dashboard only, not a public API).

## Layout

```
packages/primer        pocketbomb-primer (src/{auth,records,realtime,files,services,tools,internal})
packages/dynamite      pocketbomb-dynamite (src/{core,client,customer-account,graphql})
packages/integration   integration suite against a real PocketBomb server (private)
packages/fuse          pocketbomb-fuse (src/{node,vite})
packages/detonator     pocketbomb-detonator (src/{server,session-storage,react,adapters/node,cli})
templates/storefront-react-router  React Router v7 SSR storefront starter (Playwright smoke)
templates/app-react-router         PocketBomb application starter (pocketbomb.app.toml; Playwright smoke)
examples/core          vanilla TS: browser page (vite) + Node.js script
examples/expo-minimal  Expo app (typecheck) + Node.js runtime smoke with the mobile adapters
examples/nextjs        Next.js App Router (server/client components, login route handlers)
scripts/               server harness, hosted pages driver, example fixtures, exports check, release
```

## Development

```sh
pnpm install
pnpm build              # ESM + CJS + d.ts of every package (tsdown)
pnpm typecheck
pnpm lint               # oxlint
pnpm format:check       # oxfmt
pnpm test               # unit tests (vitest)
pnpm test:integration   # builds and starts the PocketBomb server from $POCKETBOMB_REPO (~/Development/pocketbase)
pnpm test:exports       # Node.js ESM/CJS resolution of every package export
pnpm examples           # build + typecheck the examples and run their smoke scripts against a seeded server
pnpm test:e2e           # the templates: storefront (build + Playwright + ts-plugin smokes) and app (detonator dev + Playwright)
pnpm codegen            # regenerate the template schema + gql.tada env against a seeded fuse server
```

The PocketBomb server is run with fuse: set `POCKETBOMB_SRC` (default `../pocketbase` next to this repo) or
`POCKETBOMB_BIN`. `node scripts/pocketbomb-server.ts [--seed <module>] [-- <command>]` starts one and optionally runs
a command with `POCKETBOMB_URL` and the seed env.

Releases use changesets: `pnpm changeset`, `pnpm version-packages`, `pnpm release` (see `scripts/release.ts`).
