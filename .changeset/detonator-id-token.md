---
"pocketbomb-detonator": patch
---

New `withoutIdToken(request)`: moves the `id_token` of the session token bounce to the `Authorization` header before the router of an SSR app. Without it the token ended up in the rendered HTML (e.g. the `action` of the forms), where hydration doesn't remove it. The app template uses it.
