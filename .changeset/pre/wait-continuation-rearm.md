---
'@workflow/core': patch
'@workflow/world': patch
---

A wait-continuation delivered before its wait elapses now re-arms under a fresh idempotency key instead of losing the wait's timer. Previously the re-enqueue reused a key the early delivery had already spent, so the world's dedupe window dropped it and the run slept indefinitely with nothing scheduled to wake it.
