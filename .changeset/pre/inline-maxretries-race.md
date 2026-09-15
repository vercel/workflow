---
'@workflow/core': patch
---

Fix a false "exceeded max retries" run failure: the retry-ceiling guard counted duplicate `step_started` events written by invocations racing on the same pending batch as real attempts. The owned-recovery ceiling now counts only the owning message's own starts, and the background-step ceiling counts only bare (queue-delivered) starts.
