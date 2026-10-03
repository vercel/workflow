---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Stop a retained owner without failing its run when another writer has committed the run's next position, and report the input as retryable. Preserve conflict reason codes on 409 responses so owners can recognize supersession.
