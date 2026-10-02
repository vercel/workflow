---
"@workflow/core": patch
---

Fix a hook or webhook raced against `sleep()` in a loop losing its payload: reads made while no payload has arrived now share the next payload, so a read that lost a `Promise.race` no longer takes it from the read that is still waiting.
