---
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/web-shared": patch
"@workflow/world": patch
"@workflow/cli": patch
"@workflow/web": patch
---

**BREAKING CHANGE**: Require `runId` argument for `world.steps.get`.

Refactor trace viewer to build spans entirely from events instead of fetching Steps and Hooks as separate resources. Extract trace-building pipeline into `lib/trace-builder.ts`. Add `stepEventsToStepEntity` for reconstructing step data from events.

