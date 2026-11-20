---
"@workflow/core": patch
---

Keep `@workflow/world-local`, `@workflow/world-vercel` and their dependencies out of the step registrations bundle again: the run spec routing added with spec 9 imported `getWorld` from `world.ts`, and `helpers.ts` imports it, so esbuild bundled both Worlds into every step bundle (from about 1 MB to about 3.8 MB in one app) - the import chain `get-world-lazy.ts` exists to break. It now reads the World through `getWorldLazy()`, and a test bundles each module that does and checks that `world.ts` is not among its inputs.
