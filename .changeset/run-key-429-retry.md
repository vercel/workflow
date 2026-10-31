---
"@workflow/world-vercel": patch
---

Retry a rate-limited (429) run-key fetch after its `Retry-After`, with jitter and a bounded budget, instead of failing the cross-deployment `resumeHook()` or key lookup that needed it.
