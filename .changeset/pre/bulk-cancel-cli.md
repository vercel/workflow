---
'@workflow/cli': minor
---

`workflow cancel` now bulk-cancels runs matched by `--status` (pending/running) or `--workflowName` in a single operation. Prints a compact outcome summary and exits nonzero only when a run genuinely fails.
