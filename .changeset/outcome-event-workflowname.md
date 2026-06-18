---
'@workflow/world': patch
'@workflow/core': patch
---

Emit `workflowName` on per-step events (`step_created`, `step_completed`, and lazy-start `step_started`) so the Vercel backend can build payload ref keys without an extra run lookup on each step, reducing inter-step latency.
