---
"@workflow/core": minor
---

Add `experimental_lock(key, { concurrency })`, an experimental native distributed semaphore for workflow functions; a waiting run retries on a World-computed backoff without growing its event log.
