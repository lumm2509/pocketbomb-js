# pocketbomb-fuse

The local PocketBomb dev runtime (like Shopify's mini-oxygen): it resolves the server binary,
runs it with a temporary (or persistent) data dir, creates the Owner superuser and runs your seed.

```ts
import { startFuse } from "pocketbomb-fuse/node";

const fuse = await startFuse({ seed: "./fuse.seed.ts" }); // { url, env, logs(), stop() }
```

Binary resolution: `bin` / `$POCKETBOMB_BIN`, otherwise `go build ./examples/base` of `src` / `$POCKETBOMB_SRC`
(cached by the source hash in `$POCKETBOMB_FUSE_CACHE` or `~/.cache/pocketbomb-fuse`). There are no
downloadable releases yet.

Entries: `pocketbomb-fuse/node` (`startFuse`, `resolveFuseBinary`, `signInStaff`, the hosted pages driver) and
`pocketbomb-fuse/vite` (a Vite plugin starting fuse with the dev server; `pocketbomb-dynamite/vite` has it built in).
