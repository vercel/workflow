/**
 * Process-wide state for packages a bundler may duplicate.
 *
 * # Why this exists
 *
 * A module's top-level `const`/`let` is a singleton per *module instance*, not
 * per process, and a Next.js server routinely holds several instances of the
 * same file. Next compiles its server output into independent module graphs
 * (`instrument`, app-route, `ssr`, `edge`), and a bundled module is compiled
 * into each one separately, with its own module-scope bindings. Only a package
 * left in `serverExternalPackages` collapses to one instance, because that
 * emits a runtime `require()` and Node's module cache dedupes it.
 *
 * `@workflow/core` has always been bundled, hence the `Symbol.for` World cache
 * in `runtime/world.ts`. `@workflow/world-vercel` was external until
 * vercel/workflow#3493 bundled it, and every module-scope singleton in it
 * quietly became one-per-layer. The visible casualty was the WS events
 * transport: the queue consumer registered its channel in the route copy's
 * registry and the write path looked it up in the instrumentation copy's empty
 * one, so every event fell back to HTTP for the life of the process.
 *
 * The combination that makes this bite rather than merely waste memory is that
 * core caches the *World object* on `globalThis` while the module state that
 * World closes over stays layer-local. Anything a World reaches at request time
 * therefore has to be process-wide too.
 *
 * # Using it
 *
 * Hold the state in one object and read through it, rather than reaching for a
 * top-level `let`:
 *
 * ```ts
 * const state = globalSingleton('@workflow/world-vercel//wsEventsTransports', 1, () => ({
 *   transports: new Map<string, WsEventsTransport>(),
 *   loggedWsInUse: false,
 * }));
 *
 * state.transports.set(url, transport);
 * state.loggedWsInUse = true;
 * ```
 *
 * A `let` cannot be shared by reference, so log-once latches and lazy caches
 * become fields on the state object. That is the whole migration.
 *
 * # Shape versions
 *
 * `shapeVersion` is part of the key. Two *different releases* of a package can
 * share one process (a transitive dependency pinning an older copy), and they
 * would otherwise meet on the same key with different expectations of the
 * object. Bump it whenever the state's shape changes incompatibly; an older
 * copy then keeps its own state instead of misreading yours.
 */

/**
 * Get the process-wide state for `name`, creating it on first use.
 *
 * Every copy of the calling module in the process gets the same object back,
 * because the object hangs off a `Symbol.for` key on `globalThis` rather than
 * off the module.
 *
 * @param name - Stable identifier, conventionally `<package>//<what>` (e.g.
 * `@workflow/world-vercel//httpDispatchers`). It is global to the process, so
 * qualify it with the package name.
 * @param shapeVersion - Version of the state object's shape. Bump on an
 * incompatible change so copies expecting the old shape do not read the new
 * one. See "Shape versions" above.
 * @param create - Builds the initial state. Runs at most once per process:
 * whichever copy asks first wins, so it must not close over anything
 * copy-specific.
 */
export function globalSingleton<T extends object>(
  name: string,
  shapeVersion: number,
  create: () => T
): T {
  const key = Symbol.for(`${name}/v${shapeVersion}`);
  const store = globalThis as typeof globalThis & Record<symbol, T | undefined>;
  const existing = store[key];
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  store[key] = created;
  return created;
}

/**
 * Drop the process-wide state for `name`, so the next {@link globalSingleton}
 * call rebuilds it.
 *
 * A test seam. Production code should reset fields on the state object instead:
 * other copies of the module hold a reference to the object this discards, and
 * would keep writing to the orphan.
 */
export function resetGlobalSingletonForTest(
  name: string,
  shapeVersion: number
): void {
  const key = Symbol.for(`${name}/v${shapeVersion}`);
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[key];
}
