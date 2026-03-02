---
"@workflow/core": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Optimize step handler performance and improve server-side validation

- Skip initial `world.steps.get()` call in step handler (saves one HTTP round-trip)
- Add server-side `retryAfter` validation to local and postgres worlds (HTTP 425 when not reached)
- Fix HTTP status code for step terminal state: return 409 (Conflict) instead of 410
- Fix race condition: await `step_started` event before hydration to ensure correct attempt count
