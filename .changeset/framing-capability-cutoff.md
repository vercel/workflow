---
"@workflow/core": patch
---

Correct the byte-stream framing capability cutoff so framed byte streams are never written to deployments that cannot decode them
