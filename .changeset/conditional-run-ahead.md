---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/errors': patch
---

Proof of concept: on a World that declares `capabilities.strictEventCount`, spec 9 run-ahead also runs ahead where workflow code awaits a hook. Its speculative writes are sent with `strictEventCount: true`, so a payload landing first is refused with `EventSlotTakenError` instead of committing below them, and the delivery restarts from the log.
