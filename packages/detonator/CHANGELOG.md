# pocketbomb-detonator

## 0.3.0

### Minor Changes

- a68ef6b: New `detonator install --url --token [--config] [--dotenv]`: installs a deployed application with the scopes of its manifest through the staff API (idempotent; without an `install_url` the credentials go to the env file). `scopesToPermissions` is exported from `pocketbomb-detonator/server`.
- a68ef6b: `detonator dev` can use an existing server (`--url`/`$POCKETBOMB_URL` with `--token`/`$POCKETBOMB_TOKEN`; it reuses an existing installation with new credentials and leaves the server running) and accepts `--data-dir` and `--fuse-port` for its own fuse. `DevState.owner` is `null` with an existing server.

### Patch Changes

- a68ef6b: New `withoutIdToken(request)`: moves the `id_token` of the session token bounce to the `Authorization` header before the router of an SSR app. Without it the token ended up in the rendered HTML (e.g. the `action` of the forms), where hydration doesn't remove it. The app template uses it.
- Updated dependencies [ee92060]
  - pocketbomb-primer@0.3.0
  - pocketbomb-fuse@0.2.1

## 0.2.0

### Minor Changes

- 39f26ea: Embedded applications (detcord, session tokens, no cookies) and the app proxy
  (`authenticate.public.appProxy`, `storefront.appProxy`).
- 39f26ea: P3: `pocketbomb-detonator` (install notifications, managed webhooks, extension launches, offline admin clients,
  Memory/`node:sqlite` session storages, React bindings, node adapter and the `detonator` CLI: dev, deploy, info).
  primer: the launch token type and the `associatedUser` token metadata are back (used by the online sessions).

### Patch Changes

- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
- Updated dependencies [39f26ea]
  - pocketbomb-detcord@0.2.0
  - pocketbomb-primer@0.2.0
  - pocketbomb-fuse@0.2.0
