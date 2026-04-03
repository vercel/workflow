---
"@workflow/core": patch
---

Fix `resumeHook()`/`resumeWebhook()` failing on workflow runs from pre-encryption deployments by checking the target run's `workflowCoreVersion` capabilities before encoding the payload
