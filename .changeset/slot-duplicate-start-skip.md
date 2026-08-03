---
'@workflow/core': patch
'workflow': patch
---

Skip a step whose concurrent start another handler already wrote, instead of restarting the replay to rediscover it
