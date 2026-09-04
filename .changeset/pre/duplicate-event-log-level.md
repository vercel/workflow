---
'@workflow/core': patch
'@workflow/world': patch
'workflow': patch
---

Log ignored duplicate events at `debug` instead of `info`/`error`, so a straggler no longer prints on every replay of the run.
