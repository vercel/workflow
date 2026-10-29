---
'@workflow/world-postgres': minor
---

Support `start({ hook })` behind `WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK=1` (migration `0028_add_start_hook_admissions`): admitting a run creates its start Hook in the same transaction, so the Hook resolves and accepts resumes as soon as `start()` returns. Every Hook now claims its token through a unique index, so an admission and a concurrent `createHook()` can no longer both win; the migration is required even with the flag off, and every process on the database must run this version before you enable it.
