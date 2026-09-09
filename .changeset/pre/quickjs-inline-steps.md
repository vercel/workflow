---
'@workflow/core': patch
'workflow': patch
---

QuickJS engine performance: cache compiled WebAssembly modules process-wide, and execute steps inline in a live-VM continuation loop (no queue round-trip per step, cheap events fed before step bodies, delayed wait-continuation dispatch for racing timers).
