---
'@workflow/core': patch
'workflow': patch
---

Reduce disabled debug-log allocation in the replay hot loop and use a guarded
fast path for ordinary serialized strings while preserving the existing
fallback handling for special characters and surrogate pairs.
