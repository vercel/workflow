---
"@workflow/core": patch
"workflow": patch
---

Add e2e coverage for the documented run-idempotency patterns: claim-only hook mutex (token held without payload data, released on completion), adopt-owner-result via `conflict.returnValue`, signal-the-owner via `resumeHook()`, supersede via `conflict.cancel()` and reclaim, and the route-side resume-or-start retry pattern.
