---
"@workflow/core": patch
"@workflow/errors": patch
---

Fail a run with the new `DEPLOYMENT_MISMATCH` error code when queue delivery reaches a deployment other than the one that created it, instead of exhausting retries on an undecryptable step. The failure is recorded without the origin deployment's key so it works even after that deployment is gone.
