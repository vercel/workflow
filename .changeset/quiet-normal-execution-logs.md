---
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/utils': patch
'@workflow/world': patch
---

Stop logging on healthy workflow execution. A successful run now prints nothing;
the breadcrumbs that described it are behind `DEBUG=workflow:*`, alongside the
existing HTTP and retry debug output. Warnings and errors are unchanged, so a
run that actually goes wrong is no quieter than before.

Most of this was fallout from defaulting the events transport to WebSockets:
`world-vercel: using ws events transport (…)` ran once per cold start on every
deployment, the `projectConfig` fallback warned on every CLI command, and the
routine `max_duration` / `auth_expiry` drain notice printed on healthy
long-lived runs. Also gated: `world-local`'s queue-concurrency notice,
`@workflow/world`'s active-run recovery line, and the port-detection diagnostics
in `@workflow/utils`, which keyed off `NODE_ENV=development` — the one
environment that always reaches them.
