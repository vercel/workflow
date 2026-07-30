---
'@workflow/core': patch
'@workflow/world': patch
---

Scope every queue idempotency key to the run, and number step and wait correlation IDs per kind so that inserting one kind no longer renumbers the others.
