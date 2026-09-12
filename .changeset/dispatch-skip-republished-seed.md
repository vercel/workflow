---
"@workflow/core": patch
---

Record the suspension handler's step-message publishes in the invocation's published set as soon as the handler returns, so a pass that exits early on a hook conflict, attribute event, or serialization failure no longer re-publishes those steps on the next pass. The set is keyed by step identity (correlation id plus step name, the dispatch idempotency key), so a step a later pass binds to a correlation id published under a different name is still dispatched.
