---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Retained owners re-arm the in-process sleep timer when a durable wake arrives early. Vercel World can deliver retained sleep wakes through Vercel Schedules (`WORKFLOW_SCHEDULED_WAKES=1`).
