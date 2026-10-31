---
"pocketbomb-dynamite": minor
---

New `dynamite check`: validates every `graphql()` document of the project against the codegen schema and fails with `file:line:column`. Needs `typescript` in the project (new optional peer dependency). The README documents the global ids and `fromGlobalId`.
