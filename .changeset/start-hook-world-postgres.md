---
'@workflow/world-postgres': minor
---

Support `start({ hook })` behind `WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK=1` (migration `0028_add_start_hook_admissions`): admitting a run creates its start Hook in the same transaction, so the Hook resolves and accepts resumes as soon as `start()` returns. Every worker on the database must run this version before you enable it.
