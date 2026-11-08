---
"@workflow/nitro": minor
"@workflow/nuxt": patch
---

Hand the flow route to the World when the server boots, through a server plugin, for a World that delivers in process (the Postgres World): the worker then runs in the app's process, loading the rebuilt bundle on every delivery in development. Not on Vercel deploys. Starting the World stays with the app's plugin.
