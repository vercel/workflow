---
'@workflow/world': patch
---

Document that `hookInput` and the `(runId, resumeId)` dedup contract now cover repeated deliveries of one resume rather than a producer/consumer race, and accept `lazy` as a hook-resume strategy.
