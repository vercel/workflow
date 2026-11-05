---
"@workflow/core": patch
---

Spec 9 QuickJS orchestrator: hand off to the next delivery at the invocation's inline deadline, and create new steps as background steps within `WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS` of it, as the node engine does. A delivery whose inline step ran past the deadline no longer starts the next inline step and runs into the function's maximum duration.
