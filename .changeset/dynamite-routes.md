---
"pocketbomb-dynamite": minor
---

`useCustomer().login/signup/logout(options)` of a server rendered app forward the options through the account route URL instead of dropping them (`returnTo`, `prompt`, `maxAge`, `loginHint`, `postLogoutRedirectUri`; anything else is an error). New `loginRouteURL`, `loginOptionsFromURL`, `logoutRouteURL` and `logoutOptionsFromURL`; `loginOptionsFromURL` drops an unsafe `returnTo`. `signup()` without a signup route now sends `prompt=create`.
