---
'@workflow/core': minor
'workflow': minor
---

Retain workflow execution across inline steps within one invocation; `WORKFLOW_RETAINED_VM=0` disables retention. Boundaries whose step arguments are not primitive values fall back to ordinary replay.
