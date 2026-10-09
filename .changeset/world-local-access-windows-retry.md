---
"@workflow/world-local": patch
---

Retry the file existence check in `write()` on transient Windows `EPERM`/`EBUSY`/`EACCES` errors, matching the existing rename/unlink handling.
