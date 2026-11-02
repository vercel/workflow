---
"@workflow/world-local": patch
---

Give up a message after the runtime's marked queue auth 401, logging one rate-limited line, instead of retrying it up to 256 times; a bare 401 is still retried.
