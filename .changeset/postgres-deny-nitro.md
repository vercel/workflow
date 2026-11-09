---
"@workflow/nitro": minor
---

Register the flow route with the World when the server boots, through a server plugin, for a World that delivers in process (`WORKFLOW_TARGET_WORLD` names the Postgres World, or a World of the app's own that declares `queueAuthMode: 'deny'`); the Local and Vercel Worlds are not built at boot, development reloads the rebuilt bundle on every delivery, and a failure is logged. Starting the World stays with the app's plugin.
