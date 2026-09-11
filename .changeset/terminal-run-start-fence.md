---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Reject `step_started` on terminal runs even when the step row still reads `running`: a redelivered start on a cancelled/completed run previously passed the claim and re-executed the step body whose outcome nothing would consume. In-flight steps can still write their terminal events (`step_completed`/`step_failed`) unchanged.
