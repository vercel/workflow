---
'@workflow/core': patch
---

Cache the local dev server port per process so workflow replays no longer re-run OS port discovery (which spawns `lsof` on macOS, ~60ms) on every replay.
