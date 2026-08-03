---
'@workflow/core': minor
---

Derive each run's X25519 public key at `start()` and stamp it on the run, so cross-run writers can seal payloads to the run without fetching its symmetric key.
