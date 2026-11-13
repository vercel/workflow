---
"@workflow/core": minor
"workflow": minor
---

Stabilize hook token takeover as `createHook({ force: true })`. `experimental_force` still works as a deprecated alias for `force`; passing both with different values throws.
