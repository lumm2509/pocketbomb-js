# pocketbomb-primer

## 0.2.0

### Minor Changes

- 39f26ea: Initial PocketBomb JS packages: `pocketbomb-primer` (transport, API keys, auth stores, OAuth2 account strategy, records REST, GraphQL, realtime, files; ported from the enriched JS SDK 1.0.0-alpha.0) and `pocketbomb-dynamite` (request context, storefront client, customer account client, typed GraphQL documents).

### Patch Changes

- 39f26ea: P3: `pocketbomb-detonator` (install notifications, managed webhooks, extension launches, offline admin clients,
  Memory/`node:sqlite` session storages, React bindings, node adapter and the `detonator` CLI: dev, deploy, info).
  primer: the launch token type and the `associatedUser` token metadata are back (used by the online sessions).
