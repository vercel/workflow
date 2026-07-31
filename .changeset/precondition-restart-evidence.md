---
'workflow': minor
'@workflow/core': minor
'@workflow/world-vercel': minor
'@workflow/world': minor
---

A replay restarted after a stale-snapshot rejection now checks its reloaded event log against the counts the world reported, and asks for a fresh invocation immediately when the reload cannot produce a different write.
