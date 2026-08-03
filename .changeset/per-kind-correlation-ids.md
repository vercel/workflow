---
'@workflow/core': patch
'workflow': patch
---

Add experimental `WORKFLOW_PER_KIND_CORRELATION_IDS=1`, which gives each kind of entity a workflow creates its own sequence of correlation IDs so an extra hook or sleep no longer renumbers every step after it. Off by default; a run must replay under the scheme that minted its IDs, so only turn it on while no runs are in flight unless your platform pins a run to the deployment it started on
