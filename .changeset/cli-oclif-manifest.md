---
'@workflow/cli': patch
---

Ship an oclif command manifest so the CLI loads only the command being run, and skip loading the runtime on exit when no World was created. `workflow --version` starts in about 50 ms instead of 650 ms.
