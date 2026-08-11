---
'@workflow/core': patch
---

Describe webhook token generation accurately in the `HookOptions.token` docs: generated tokens come from the run's deterministic sequence (stable across replays and concurrent invocations), and callers should authenticate webhook requests rather than rely on URL secrecy.
