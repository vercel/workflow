---
"@workflow/utils": minor
---

Add queue auth helpers: `QUEUE_AUTH_HEADER`, the key functions (`generateQueueAuthKey()`, `getQueueAuthKey()`, `isQueueAuthKey()`, `isWellFormedQueueAuthKey()`, `setQueueAuthKeySource()`, `clearQueueAuthKeySources()`, `verifyQueueAuthKey()`), the refusal marker (`isQueueAuthRefusal()`, `QUEUE_AUTH_REFUSED_HEADER`, `QUEUE_AUTH_REFUSED_CODE`) and `createLogLimiter()`.
