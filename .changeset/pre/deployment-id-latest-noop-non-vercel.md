---
'@workflow/core': patch
---

`start({ deploymentId: 'latest' })` is now a no-op in Worlds that don't support atomic deployments (local dev, Postgres) instead of throwing — it logs a warning and targets the current deployment, so workflows that use `'latest'` on Vercel still run locally.
