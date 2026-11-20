---
'@workflow/core': patch
---

Spec 9 run-ahead: an incremental read of the event log no longer moves its position past an event it did not take in. A read can return one of the orchestrator's own speculative writes before that write's answer; if the answer then came back incomplete, the event was left out of the log until a full reload.
