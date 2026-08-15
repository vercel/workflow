---
'@workflow/core': patch
---

Detect wedged waits (a wait event write that conflicts while its event-log row is never readable) instead of silently wake-looping forever: a wedged completion warns within a tunable threshold (`WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS`, default 10 minutes) and then fails the run as `CORRUPTED_EVENT_LOG`; a wedged creation is detected and warned about but left to backend-side recovery (no per-wait replay-stable time anchor exists to escalate on safely).
