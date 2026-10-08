---
'@workflow/cli': patch
---

`workflow inspect step <step-id>` requires `--runId` and fails before contacting the backend without it, instead of looking for the step in the most recent run. The steps table hint includes `--runId`.
