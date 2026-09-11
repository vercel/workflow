---
'@workflow/world': minor
'@workflow/core': minor
---

Carry immutable run identity on step-execution queue messages to skip the blocking `runs.get` before starting a step, fetching the run row only when continuing into replay. Messages without `runContext` keep the previous behavior.
