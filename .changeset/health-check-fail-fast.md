---
"@workflow/core": patch
---

`healthCheck()` now returns as soon as the world refuses its stream read with a 4xx that polling cannot change (e.g. 400, 401, 403), reporting that error instead of re-reading every 100ms until the timeout. A 404, 408, 409, 425, 429 or 5xx is still polled through.
