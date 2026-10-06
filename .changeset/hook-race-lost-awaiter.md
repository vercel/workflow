---
"@workflow/core": patch
---

Deliver a hook payload to the pending await when an earlier `Promise.race` over the same hook was lost

Concurrent awaits of one hook, such as `Promise.all([hook, hook])`, may now receive the same payload.
