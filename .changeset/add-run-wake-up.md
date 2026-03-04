---
"@workflow/core": patch
"workflow": patch
"@workflow/vitest": patch
"@workflow/world-local": patch
---

Add `Run.wakeUp()` method to programmatically interrupt pending `sleep()` calls. Add `waitForSleep()` and `waitForHook()` test helpers to `@workflow/vitest`. Add `clear()` method to local world for test isolation.
