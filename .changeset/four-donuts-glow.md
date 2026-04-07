---
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/world": patch
"@workflow/core": patch
---

Allow workflow invocation to create run if initial storage call in `start` did not succeed. Send run input through queue to enable this. Allow creating run_created and run_started events together in World, and skip first event list call by returning events directly.
