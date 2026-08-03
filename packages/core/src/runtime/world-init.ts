/**
 * Server-only side-effect module that ensures `world.ts` is loaded so its
 * module-load side effect — `globalThis[GetWorldFnKey] ??= getWorld` —
 * fires in host bundles.
 *
 * # Why this exists
 *
 * `getWorldLazy()` in `./get-world-lazy.ts` checks the globalThis cache
 * populated by `world.ts`'s module-load side effect. When a server route
 * only consumes a helper that goes through `getWorldLazy` — for example
 * `start` from `workflow/api`, or `defineHook().resume()` from `workflow`
 * — webpack/turbopack can tree-shake the named import `{ getWorld }` out
 * of `runtime.ts`, taking `world.ts`'s module evaluation with it. The
 * globalThis registration never fires.
 *
 * Importing this module for its side effect from the host-side `workflow`
 * and `workflow/api` entries guarantees `world.ts` enters the bundle, the
 * global is registered at module load, and `getWorldLazy()` short-circuits
 * to the registered function on the first call.
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
 * `world.ts` as intended. The split keeps the configured world package
 * and other server-only deps out of the workflow sandbox bundle.
 *
 * # Maintenance notes
 *
 * If you add another `getWorldLazy()` consumer that's reachable from a
 * host route without going through `workflow` or `workflow/api`, make
 * sure that entry also imports this module — or that it transitively
 * reaches `world.ts` via a non-tree-shakeable path. Adding a regression
 * test in `world-init.test.ts` is preferred to relying on careful manual
 * tracing.
 */
import './world.js';
