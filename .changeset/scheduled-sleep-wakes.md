---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Retained-owner sleeps pass their deadline as `wakeAt` and re-arm the in-process timer on early wakes. Vercel World can deliver these wakes through Vercel Schedules (`WORKFLOW_SCHEDULED_WAKES=1`).
