---
'@workflow/core': patch
---

Harden `wait_completed.resumeAt` validation so it only runs the equality check when an authoritative recorded value exists (a `wait_created` was applied, or the sleep used an absolute `Date`), preventing a spurious `CorruptedEventLogError` while still rejecting malformed `resumeAt` values.
