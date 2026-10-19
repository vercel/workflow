---
"@workflow/core": minor
---

Add `lock(key, { concurrency })`, a native distributed semaphore for workflow functions; a waiting run retries on a World-computed backoff without growing its event log.
