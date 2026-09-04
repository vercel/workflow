---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Fix duplicate inline step execution when a hook or wait wakes a run while the step is still running (#2780). The lazy `step_started` now records the owning queue message ID, and wake replays schedule a delayed backstop for in-flight inline steps instead of immediately re-dispatching them. Disable with `WORKFLOW_INLINE_OWNERSHIP=0`.
