---
"pocketbomb-dynamite": patch
---

`dynamite codegen`: the generated `.dynamite/schema.graphql` no longer depends on the order of the introspection types. The server doesn't guarantee that order, so the file was rewritten and reported as changed on every watcher tick.
