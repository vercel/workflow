---
'@workflow/core': patch
'workflow': patch
---

Fix a replay-determinism gap where branch wake order — and therefore step correlation ids — could depend on how much of the event log an invocation had loaded, corrupting runs under concurrent replays (CORRUPTED_EVENT_LOG).
