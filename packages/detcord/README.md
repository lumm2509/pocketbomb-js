# pocketbomb-detcord

The App Bridge of the PocketBomb embedded applications. Browser only, no dependencies: it talks to the dashboard
host with `postMessage` (exact origin checks on both sides, and the parent window source check).

```ts
import { detcord } from "pocketbomb-detcord";

await detcord.idToken();                               // the 60s session token (cached and renewed)
detcord.navigation.navigate("/app/orders");            // ... and the dashboard hash stays in sync
detcord.navigation.onChange((path) => router.go(path));
detcord.toast.show("Saved");
detcord.modal.open({ id: "m1", title: "Hello", message: "..." });
detcord.modal.close();
detcord.titleBar.set("Orders");
detcord.resize(600);
await detcord.ready; detcord.record;                   // the launch record context ({collection, id} or null)
```

The same-origin `fetch` requests automatically get `Authorization: Bearer <idToken>` (like App Bridge).

`detcordScript` is the classic-script form for the document `<head>` (see `pocketbomb-detonator` and the app template).
Installing it also removes the `id_token` query param from the URL with `history.replaceState`.
