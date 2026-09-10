---
'@workflow/utils': minor
---

Add `globalSingleton()`, which parks a package's process-wide state on `globalThis` so bundled copies of a module in one process share it.
