---
"@workflow/core": minor
"workflow": minor
"@workflow/world": minor
---

Make `resumeHook()` resilient to transient `hook_received` event write failures (429/5xx) by carrying the payload on the queue message for the runtime to materialize. Returned `Hook` gets a new `resilientResume: true` flag when this fallback path is taken.
