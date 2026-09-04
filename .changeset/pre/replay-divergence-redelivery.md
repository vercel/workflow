---
'@workflow/core': patch
'@workflow/errors': patch
'@workflow/world': patch
---

Retry transient workflow replay divergence before classifying repeated divergence as a corrupted event log.
