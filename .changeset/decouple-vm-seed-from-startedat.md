---
'@workflow/core': minor
---

Derive the workflow VM's deterministic RNG seed from `runId:workflowName:deploymentId` (instead of including the run's `startedAt`) and its initial fixed clock from the ULID timestamp embedded in `runId`. These inputs are all available the moment a queue message arrives, decoupling VM setup from the `run_started` round-trip. Note: this changes the seed-derived value sequence (step/hook correlation IDs, nanoids, random values) for a given run, so runs started before this change must not be replayed across the upgrade.
