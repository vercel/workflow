---
"@workflow/world": patch
"@workflow/core": patch
---

Forward the run's `encryptionPublicKey` on a resilient `run_started`, so a run created from its queued copy can still receive sealed writes.
