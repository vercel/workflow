---
"@workflow/core": patch
---

Record the suspension handler's step-message publishes in the invocation's published set as soon as the handler returns, so a pass that exits early on a hook conflict, attribute event, or serialization failure no longer re-publishes those steps on the next pass.
