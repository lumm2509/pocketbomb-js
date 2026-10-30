# Changesets

Every user-facing change of a published package (`@pocketbomb/primer`, `@pocketbomb/dynamite`)
needs a changeset: run `pnpm changeset`, pick the packages and the semver bump and describe the change.

`pnpm version-packages` applies the pending changesets (versions + CHANGELOG.md) and
`pnpm release` builds, checks and publishes the new versions (see `scripts/release.ts`).
