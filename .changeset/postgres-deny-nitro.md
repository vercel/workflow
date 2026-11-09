---
"@workflow/nitro": minor
"@workflow/nuxt": patch
---

Register the flow route with the World when the server boots, through a server plugin, when `WORKFLOW_TARGET_WORLD` is `@workflow/world-postgres` (development reloads the rebuilt bundle on every delivery; a failure is logged). Starting the World stays with the app's plugin.
