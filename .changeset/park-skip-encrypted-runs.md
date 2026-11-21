---
"@workflow/core": patch
---

A spec 9 run with an encryption key parks no VM between deliveries unless `WORKFLOW_PARKED_VM_ENCRYPTED=1` is set, so its decrypted payloads don't outlive the delivery that decrypted them.
