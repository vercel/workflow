---
"@workflow/core": patch
---

Deliver a hook payload to the pending await when an earlier `Promise.race` over the same hook was lost

**Breaking:** with no payload available, `Promise.all([hook, hook])` now resolves both entries with the same next payload instead of two successive payloads.
