---
'@workflow/cli': patch
'@workflow/web': patch
---

Resolve a run's encryption key from metadata only when decrypting in `workflow inspect --decrypt` and the web UI, instead of making the server resolve the run's whole input and output for each lookup.
