/**
 * Server-only side-effect module that ensures `world.ts` is loaded so its
 * module-load side effect — `globalThis[GetWorldFnKey] ??= getWorld` —
 * fires in host bundles.
 *
 * # Why this exists
 *
 * `getWorldLazy()` in `./get-world-lazy.ts` checks the globalThis cache
 * (populated by `world.ts`'s module-load side effect) before falling back
 * to a runtime-built dynamic `import('./world.js')`. When a server route
 * only consumes a single helper that goes through `getWorldLazy` — most
 * commonly `start` from `workflow/api` — webpack/turbopack tree-shake the
 * named import `{ getWorld } from './runtime/world.js'` out of
 * `runtime.ts`, taking `world.ts`'s module evaluation with it. The
 * globalThis registration never fires.
 *
 * `getWorldLazy` then falls through to its dynamic-import fallback, which
 * itself fails: webpack inlines `get-world-lazy.js` into the bundled route
 * file, so the relative specifier `./world.js` resolves against
 * `/var/task/<app>/.next/server/app/<...>/route.js` — where no sibling
 * `world.js` exists — and Node throws `MODULE_NOT_FOUND`. The symptom is a
 * cold-start regression: the very first user request that goes through
 * `start()` fails until some other code path (typically the queue-driven
 * `/.well-known/workflow/v1/flow` route, which uses `getWorld` directly
 * via `workflowEntrypoint`) has loaded `world.ts` and populated the
 * cache.
 *
 * Importing this module for its side effect — exactly once, from the
 * host-side `workflow/api` (`packages/workflow/src/api.ts`) — guarantees
 * `world.ts` enters the bundle, the global is registered at module load,
 * and `getWorldLazy()` short-circuits to the registered function on the
 * first call.
 *
 * # Why a separate module instead of importing `./world.js` directly
 *
 * `world.ts` is internal to `@workflow/core` and not part of the public
 * exports surface. Adding a dedicated public init entry (this file)
 * keeps the side-effect intent obvious to anyone reading
 * `packages/workflow/src/api.ts`, and lets the `workflow` export
 * condition route to a stub for VM/step bundles (see below).
 *
 * # Why this doesn't break VM/step bundles
 *
 * The `@workflow/core/runtime/world-init` export resolves via the
 * `workflow` condition to `./dist/workflow/world-init-stub.js`, an empty
 * module. Esbuild runs the workflow VM and step bundlers with the
 * `workflow` condition active, so they pick up the stub and never reach
 * `world.ts`. Host bundlers (webpack, turbopack, Node.js) use the
 * `default` (or `node`) condition and pick up this file, loading
 * `world.ts` as intended. The split keeps `@workflow/world-vercel`,
 * `@workflow/world-local`, `cbor-x`, and other server-only deps out of
 * the workflow sandbox bundle.
 *
 * # Why we keep the `getWorldLazy` dynamic-import fallback
 *
 * The fallback remains in `./get-world-lazy.ts` as a defense-in-depth for
 * environments we haven't accounted for (CJS test runners, scripts that
 * import `start` without going through `workflow/api`, future bundlers
 * with stricter tree-shaking). With this init module in place, the
 * fallback should never fire in normal use — but if it does, the
 * dynamic-import branch still resolves correctly when `world.js` is
 * physically adjacent on disk (e.g., direct Node.js execution of
 * unbundled source).
 *
 * # Maintenance notes
 *
 * If you add another `getWorldLazy()` consumer that's reachable from a
 * host route without going through `workflow/api` (e.g., a new helper in
 * `workflow/runtime`), make sure that entry also imports this module —
 * or that it transitively reaches `world.ts` via a non-tree-shakeable
 * path. Adding a regression test in `world-init.test.ts` is preferred to
 * relying on careful manual tracing.
 */
import './world.js';
