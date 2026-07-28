---
'@workflow/core': minor
---

`resumeHook()` now seals its payload to the target run's published public key when one is present, removing the cross-deployment `run-key` API round trip from hook resumption. Readers resolve the full key capability so they can open sealed payloads.
