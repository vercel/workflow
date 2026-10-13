---
"@workflow/core": patch
---

Stamp the default snapshot threshold into QuickJS runs at `start()` so they qualify for the event limit exemption, warn when a run approaches the event limit, and recommend `WORKFLOW_VM=quickjs` in `MAX_EVENTS_EXCEEDED` and `REPLAY_TIMEOUT` errors
