---
'@workflow/world-local': patch
---

Scope untagged startup recovery to untagged runs so a dev server no longer re-enqueues tagged runs (e.g. left behind by the vitest harness in a shared data directory), which previously failed `run_started` with "did not return the run entity".
