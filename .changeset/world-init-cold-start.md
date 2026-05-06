---
"@workflow/core": patch
"workflow": patch
---

Fix cold-start regression where the first server request that goes through `start()` (or any `getWorldLazy()` consumer) failed with `Cannot find module './world.js'`. Webpack/Turbopack tree-shake `runtime/world.ts` out of routes that don't statically use `getWorld`, so the `globalThis` registration in `world.ts` never fires, and the `getWorldLazy()` dynamic-import fallback can't survive bundler inlining of `get-world-lazy.js` into the route file. A new server-only side-effect module `@workflow/core/runtime/world-init` (resolved to an empty stub via the `workflow` export condition for VM/step bundles) is imported by `workflow/api`'s host file, guaranteeing `world.ts` enters the host bundle.
