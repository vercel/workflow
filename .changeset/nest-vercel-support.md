---
'@workflow/nest': minor
---

Add Vercel deployment support for NestJS apps. `workflow-nest build --vercel` (also triggered automatically when the `VERCEL` env var is set) now emits a Vercel Build Output API directory: the combined workflow queue-consumer function is produced by the shared `VercelBuildOutputAPIBuilder` — registered with `experimentalTriggers` so Vercel Queue discovers it — alongside the NestJS app bundled as a catch-all function, with the routing merged into `config.json`. Previously deployed NestJS workflows stayed `pending` because no consumer was registered.

`WorkflowModule` now lazy-loads the build toolchain (`@workflow/builders`, esbuild, SWC) so importing it no longer drags the compiler into the runtime bundle; the builders are still available via the `workflow/nest/builder` and `workflow/nest/vercel-builder` subpaths.
