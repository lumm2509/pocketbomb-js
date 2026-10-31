# pocketbomb-dynamite

## 0.3.0

### Minor Changes

- 46358ac: New `dynamite check`: validates every `graphql()` document of the project against the codegen schema and fails with `file:line:column`. Needs `typescript` in the project (new optional peer dependency). The README documents the global ids and `fromGlobalId`.
- 46358ac: `useCustomer().login/signup/logout(options)` of a server rendered app forward the options through the account route URL instead of dropping them (`returnTo`, `prompt`, `maxAge`, `loginHint`, `postLogoutRedirectUri`; anything else is an error). New `loginRouteURL`, `loginOptionsFromURL`, `logoutRouteURL` and `logoutOptionsFromURL`; `loginOptionsFromURL` drops an unsafe `returnTo`. `signup()` without a signup route now sends `prompt=create`.

### Patch Changes

- 46358ac: The Vite plugin pre-optimizes `pocketbomb-dynamite/graphql` and `pocketbomb-dynamite/react`, so a first visit after a cold install no longer reloads the page halfway through.
- 46358ac: `dynamite codegen`: the generated `.dynamite/schema.graphql` no longer depends on the order of the introspection types. The server doesn't guarantee that order, so the file was rewritten and reported as changed on every watcher tick.
- Updated dependencies [ee92060]
  - pocketbomb-primer@0.3.0
  - pocketbomb-fuse@0.2.1

## 0.2.0

### Minor Changes

- 39f26ea: Embedded applications (detcord, session tokens, no cookies) and the app proxy
  (`authenticate.public.appProxy`, `storefront.appProxy`).
- 39f26ea: Initial PocketBomb JS packages: `pocketbomb-primer` (transport, API keys, auth stores, OAuth2 account strategy, records REST, GraphQL, realtime, files; ported from the enriched JS SDK 1.0.0-alpha.0) and `pocketbomb-dynamite` (request context, storefront client, customer account client, typed GraphQL documents).
- 39f26ea: P2: `pocketbomb-fuse` (local PocketBomb runtime: binary resolution/build cache, seeds, Vite plugin) and the dynamite
  gql.tada `graphql()` documents, `dynamite` CLI (codegen, dev, info), Vite plugin (env, private key guard, dev proxy,
  codegen, fuse), TypeScript plugin (graphqlsp) and React bindings (DynamiteProvider, useCustomer, useStorefrontQuery,
  Pagination, FileImage). Breaking: the dynamite runtime `graphql(client, doc)` helper is now `executeGraphQL`.

### Patch Changes

- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
  - pocketbomb-primer@0.2.0
  - pocketbomb-fuse@0.2.0
