---
"@workflow/world": patch
"workflow": patch
---

Make `run.input` and `step.input` `.optional()` on the World snapshot schemas so consumers no longer fail validation when the service externalizes payloads as `RemoteRef` blobs.
