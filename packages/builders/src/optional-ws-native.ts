/**
 * `bufferutil` and `utf-8-validate` are optional native accelerators for the
 * `ws` package, which `@workflow/world-vercel` uses for its WebSocket events
 * transport. Neither is installed by default: `ws` requires each one inside a
 * try/catch and falls back to a pure-JS implementation when the require throws.
 *
 * Marking them external keeps that fallback reachable. Two bundlers take it away
 * without changing the build's outcome, so the damage only shows up at runtime,
 * on the first frame big enough to reach the native masker (`ws` uses pure JS
 * below 48 bytes, so small-payload smoke tests pass; CBOR event frames don't):
 *
 * - **webpack** bundles the JS wrapper without its native `.node` binding.
 * - **Vite** resolves the absent peer to its own `optional-peer-dep` stub, so
 *   `ws`'s require *succeeds* and the try/catch never fires.
 *
 * Both end at `bufferUtil.mask is not a function`. Rollup-family setups are not
 * known to break: nothing substitutes a stub, and nitro traces and externalizes
 * `ws` in a production build, so the require stays a real one that fails and the
 * fallback engages. Externalizing there buys determinism against a change in
 * externals policy, not a fix for a known break. (Turbopack already externalizes
 * Node packages.)
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
