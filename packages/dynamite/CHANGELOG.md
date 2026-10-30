# @pocketbomb/dynamite

## 0.2.0

### Minor Changes

- 39f26ea: Embedded applications (detcord, session tokens, no cookies) and the app proxy
  (`authenticate.public.appProxy`, `storefront.appProxy`).
- 39f26ea: Initial PocketBomb JS packages: `@pocketbomb/primer` (transport, API keys, auth stores, OAuth2 account strategy, records REST, GraphQL, realtime, files; ported from the enriched JS SDK 1.0.0-alpha.0) and `@pocketbomb/dynamite` (request context, storefront client, customer account client, typed GraphQL documents).
- 39f26ea: P2: `@pocketbomb/fuse` (local PocketBomb runtime: binary resolution/build cache, seeds, Vite plugin) and the dynamite
  gql.tada `graphql()` documents, `dynamite` CLI (codegen, dev, info), Vite plugin (env, private key guard, dev proxy,
  codegen, fuse), TypeScript plugin (graphqlsp) and React bindings (DynamiteProvider, useCustomer, useStorefrontQuery,
  Pagination, FileImage). Breaking: the dynamite runtime `graphql(client, doc)` helper is now `executeGraphQL`.

### Patch Changes

- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
  - @pocketbomb/primer@0.2.0
  - @pocketbomb/fuse@0.2.0
