---
'@workflow/world-local': patch
---

Add atomic terminal-state guards to step and wait transitions using `writeExclusive` lock files. Prevents concurrent `step_completed`/`step_failed`/`wait_completed` races and blocks `step_started` on already-terminal steps. Also adds `cancelled` to `isStepTerminal`.
