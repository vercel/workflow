---
'@workflow/world-postgres': minor
---

Support atomic start Hook admission behind `WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK=1` (migration `0028_add_start_hook_admissions`); concurrent `createHook()`s of one token now leave one owner. Every worker on the database must run this version before you enable it.
