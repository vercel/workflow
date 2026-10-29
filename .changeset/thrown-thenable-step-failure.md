---
"@workflow/core": patch
---

Record a step's retry or failure right away when the step throws a thenable that never settles or keeps resolving to itself, or an error whose cause cannot be serialized, instead of losing the event and waiting for queue redelivery.
