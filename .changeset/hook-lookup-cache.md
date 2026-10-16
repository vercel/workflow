---
'@workflow/core': patch
---

`resumeHook(token)` reuses a recent by-token lookup for repeated resumes of the same hook, saving one round trip per resume; a reused hook that turns out to be gone is retried with a fresh lookup. Tune with `WORKFLOW_HOOK_LOOKUP_CACHE_TTL_MS` (`0` disables).
