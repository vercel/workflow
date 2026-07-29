---
"@workflow/core": patch
"@workflow/errors": minor
"@workflow/world": minor
"@workflow/world-vercel": patch
---

Re-route a queue delivery that reaches a deployment other than the one its run is pinned to, and fail the run with the new `DEPLOYMENT_MISMATCH` error code once the retry budget is spent, instead of exhausting retries on an undecryptable step.
