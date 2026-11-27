/**
 * The app's flow entry, loaded on demand by `start()` and `resumeHook()` to run
 * a run's orchestrator delivery inline (see `runtime/inline-orchestrator.ts`).
 *
 * Framework integrations alias `@workflow/core/inline-entry` to the generated
 * flow route for server builds, so loading it registers that route's
 * orchestrator handler and step functions in the calling process. This module
 * is what the specifier resolves to everywhere else: it registers nothing, and
 * the run is queued as usual.
 *
 * @internal
 */
export {};
