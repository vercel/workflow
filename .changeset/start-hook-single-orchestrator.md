---
'@workflow/core': patch
---

The single-orchestrator engine admits `start({ hook })` candidates: their first delivery skips turbo, `run_started` carries the reservation and public key, and a refused candidate acknowledges without running code.
