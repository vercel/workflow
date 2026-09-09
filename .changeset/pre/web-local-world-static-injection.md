---
'@workflow/web': patch
---

Fix `workflow web` for local and postgres backends after static world-target injection. The web server now constructs the local world directly and resolves other world packages from the inspected project, instead of calling the `createWorld()` static-injection stub (which throws when no build plugin aliased it).
