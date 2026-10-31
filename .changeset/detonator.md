---
"pocketbomb-detonator": minor
---

`detonator dev` can use an existing server (`--url`/`$POCKETBOMB_URL` with `--token`/`$POCKETBOMB_TOKEN`; it reuses an existing installation with new credentials and leaves the server running) and accepts `--data-dir` and `--fuse-port` for its own fuse. `DevState.owner` is `null` with an existing server.
