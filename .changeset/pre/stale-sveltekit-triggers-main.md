---
'@workflow/sveltekit': patch
---

Fix duplicate Workflow queue consumers in SvelteKit deployments by removing stale workflow queue triggers from shared Vercel function configs.
