---
"@workflow/world-local": patch
---

Store event and step files in one directory per run (`events/<runId>/`, `steps/<runId>/`), so creating an event and listing a run's events or steps costs time proportional to that run instead of to every file in the data directory. Existing data directories are converted in place on first use; downgrading afterwards requires moving the files back.
