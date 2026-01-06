---
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/web-shared": patch
---

Add `specVersion` property to World interface for backwards compatibility

- Added `specVersion` property to the World interface that exposes the npm package version
- Added `specVersion` to WorkflowRun schema and run_created event data
- World implementations (world-vercel, world-local, world-postgres) now set specVersion from their package version using genversion
- Server can use specVersion to route operations based on the world version that created the run
- Added specVersion display to the observability UI attribute panel
