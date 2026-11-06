---
"@workflow/core": patch
---

Spec 9: a run that waits only on open hooks now lingers for `WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS` (default 5 seconds, never more than `WORKFLOW_ORCHESTRATOR_LINGER_MS`) instead of the full 30 seconds after each idle pass, so a long-lived approval or cancel hook beside a polling `sleep()` holds each wake for up to 5 seconds. A run with a background step still open keeps the full linger.
