---
"@workflow/core": patch
---

Cache the compiled workflow-bundle `vm.Script` per process so replays reuse the compiled bundle instead of re-parsing it on every iteration.
