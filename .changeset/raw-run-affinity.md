---
"@workflow/world-vercel": patch
---

Use the run ID itself as the direct-invocation affinity selector for newly
created runs. Persist the selector strategy in run execution context so older
pinned runs continue using their original routing key across SDK upgrades.
