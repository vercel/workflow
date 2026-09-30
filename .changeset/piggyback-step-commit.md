---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/errors': patch
---

Add an opt-in piggyback commit that writes a step's completion together with the next step's start, or with the run's outcome, as one fenced, atomic request (`WORKFLOW_PIGGYBACK_COMMIT`, `WORKFLOW_PIGGYBACK_RUN_END`; both off by default).
