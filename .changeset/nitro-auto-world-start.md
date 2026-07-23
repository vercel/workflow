---
'@workflow/nitro': minor
---

Start the workflow World automatically at server boot via a generated Nitro plugin, so self-hosted Nitro apps (Nitro v2/v3, Nuxt, Express/Hono/Fastify on Nitro) recover in-flight runs after a restart with no manual wiring. This applies to any non-Vercel world: both the local and Postgres worlds now run boot-time recovery on Nitro. The plugin bakes in `nitro.options.dev` (Nitro's authoritative dev/prod flag), so in `nitro dev` it cancels previous in-flight runs (their workflow code may have changed) and in a production build it recovers them — zero config. Skipped on Vercel deploys, where the push-based Vercel World needs no recovery.
