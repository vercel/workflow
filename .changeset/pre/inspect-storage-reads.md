---
"@workflow/world-vercel": patch
---

Add `WORKFLOW_DISABLE_ANALYTICS_READS=1` to opt the world's `analytics` read namespace off, forcing `workflow inspect` list paths onto strongly consistent primary storage. Intended for tests and tooling that read entities immediately after writing them, where the analytics store's asynchronous ingestion can return stale pages.
