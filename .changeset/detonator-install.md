---
"pocketbomb-detonator": minor
---

New `detonator install --url --token [--config] [--dotenv]`: installs a deployed application with the scopes of its manifest through the staff API (idempotent; without an `install_url` the credentials go to the env file). `scopesToPermissions` is exported from `pocketbomb-detonator/server`.
