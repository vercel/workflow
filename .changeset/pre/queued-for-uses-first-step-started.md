---
"@workflow/web-shared": patch
---

Fix the "Queued for" duration shown in the events list for retried steps. It now measures from `step_created` to the first `step_started` instead of the last, so the displayed value reflects actual queue time rather than queue time plus all retry waits.
