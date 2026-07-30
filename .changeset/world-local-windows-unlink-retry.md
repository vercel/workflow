---
'@workflow/world-local': patch
---

Retry transient `EPERM` unlink failures on Windows when deleting hook and entity JSON files. A concurrent reader briefly holding a file open made `deleteJSON` throw a share-violation `EPERM`, which surfaced as a failed operation — for example a failed `run.cancel()` while `deleteAllHooksForRun` raced hook polling.
