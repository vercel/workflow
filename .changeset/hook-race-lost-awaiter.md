---
"@workflow/core": patch
---

Deliver a hook payload to the pending await when an earlier `Promise.race` over the same hook was lost

Concurrent awaits of one hook, such as `Promise.all([hook, hook])`, may now receive the same payload. Runs that already took the timeout branch in this situation may fail to replay after upgrading in place.
