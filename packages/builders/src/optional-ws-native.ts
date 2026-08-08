/**
 * `bufferutil` and `utf-8-validate` are optional native accelerators for the
 * `ws` package, which `@workflow/world-vercel` uses for its WebSocket events
 * transport. Neither is installed by default: `ws` requires each one inside a
 * try/catch and falls back to a pure-JS implementation when the require throws.
 *
 * Marking them external lets that fallback happen. Two bundlers break without
 * it, differently: **Rollup/Vite/Nitro** fail the build on the unresolvable
 * `require` (`Could not resolve "bufferutil" imported by "ws"`), and **webpack**
 * builds but bundles the JS wrapper without its native `.node` binding, throwing
 * `bufferUtil.mask is not a function` at runtime. (Turbopack externalizes Node
 * packages differently and doesn't hit either.)
 *
 * Externalized unconditionally, unlike `WORKFLOW_OPTIONAL_OTEL_API_MODULE`,
 * which is only externalized when it can't be resolved. The OTEL API has to
 * load for tracing to work, so a self-contained output must bundle it when
 * present; these accelerators must specifically *not* load, so a failed runtime
 * require is the designed path and a half-bundled native module is not.
 */
export const WORKFLOW_OPTIONAL_WS_NATIVE_MODULES = [
  'bufferutil',
  'utf-8-validate',
] as const;
