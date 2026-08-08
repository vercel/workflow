/**
 * `bufferutil` and `utf-8-validate` are optional native accelerators for the
 * `ws` package, which `@workflow/world-vercel` uses for its WebSocket events
 * transport. Neither is installed by default: `ws` requires each one inside a
 * try/catch and falls back to a pure-JS implementation when the require throws.
 *
 * Every bundler needs to be told to leave them alone, for two different
 * reasons:
 *
 * - **Rollup/Vite/Nitro** fail the *build* outright — `Could not resolve
 *   "bufferutil" imported by "ws"` — because they treat an unresolvable
 *   `require()` as fatal.
 * - **Webpack** succeeds at build time but bundles the JS wrapper without the
 *   native `.node` binding it needs, producing a broken partial module that
 *   throws `bufferUtil.mask is not a function` at *runtime* on the server
 *   build. (Turbopack externalizes Node packages differently and doesn't hit
 *   this.)
 *
 * Both are fixed by marking these two specifiers external, so `ws` performs a
 * real `require()` at runtime and takes its documented fallback when they
 * aren't there.
 *
 * Note this is the OPPOSITE treatment from
 * `WORKFLOW_OPTIONAL_OTEL_API_MODULE`, which is only externalized when it
 * *can't* be resolved. The difference is what the runtime needs: the OTEL API
 * must actually load for tracing to work, so a self-contained output has to
 * bundle it when present. These accelerators must specifically NOT load —
 * they're a performance nicety with a correct fallback — so externalizing them
 * unconditionally is both simpler and safer than resolving them and risking a
 * half-bundled native module.
 */
export const WORKFLOW_OPTIONAL_WS_NATIVE_MODULES = [
  'bufferutil',
  'utf-8-validate',
] as const;

/** True when `source` is one of the `ws` optional native accelerators (or a
 *  deep import into one). */
export function isOptionalWsNativeModule(source: string): boolean {
  return WORKFLOW_OPTIONAL_WS_NATIVE_MODULES.some(
    (name) => source === name || source.startsWith(`${name}/`)
  );
}
