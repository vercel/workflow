---
"@workflow/world-vercel": patch
---

Route `experimental_lock()` events to the backend behind `WORKFLOW_VERCEL_EXPERIMENTAL_LOCKS=1`, and map a backend's lock refusal to `LockUnsupportedError`.
