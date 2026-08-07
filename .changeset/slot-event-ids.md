---
'@workflow/world-postgres': patch
'@workflow/world-local': patch
'@workflow/world': patch
---

Event IDs are now a dense per-run slot number, so a writer can tell a world how many events it had read and get back the ones it did not see.
