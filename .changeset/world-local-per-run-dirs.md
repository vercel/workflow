---
"@workflow/world-local": minor
---

Store event and step files in one directory per run (`events/<runId>/`, `steps/<runId>/`), so reading or appending to a run costs time proportional to that run instead of to every run the data directory holds. New data directories use the run-scoped layout. Existing data directories keep the flat layout and are never converted implicitly; convert one with `npx -p @workflow/world-local workflow-local-layout migrate <dataDir>` (or `migrateLayout: true`) after stopping every process using it. Releases before this one cannot read a run-scoped data directory: run `workflow-local-layout flatten <dataDir>` before downgrading.
