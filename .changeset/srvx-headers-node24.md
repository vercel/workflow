---
"@workflow/core": patch
---

Fix webhooks returning 404 on Nitro apps running Node 24, where serializing the request's headers failed.
