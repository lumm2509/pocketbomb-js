---
"@pocketbomb/dynamite": minor
"@pocketbomb/fuse": minor
---

P2: `@pocketbomb/fuse` (local PocketBomb runtime: binary resolution/build cache, seeds, Vite plugin) and the dynamite
gql.tada `graphql()` documents, `dynamite` CLI (codegen, dev, info), Vite plugin (env, private key guard, dev proxy,
codegen, fuse), TypeScript plugin (graphqlsp) and React bindings (DynamiteProvider, useCustomer, useStorefrontQuery,
Pagination, FileImage). Breaking: the dynamite runtime `graphql(client, doc)` helper is now `executeGraphQL`.
