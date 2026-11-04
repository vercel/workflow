---
"@workflow/world-local": patch
---

Stop retrying a message the runtime refuses with its marked queue auth 401 after a few attempts, logging one rate-limited line, instead of retrying it up to 256 times; a bare 401 keeps its normal retries.
