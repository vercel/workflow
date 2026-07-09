/**
 * `@opentelemetry/api` is an optional peer dependency of the Workflow SDK: the
 * runtime imports it lazily inside a try/catch so tracing is a no-op when it
 * isn't installed. Rollup/Vite (e.g. SvelteKit's build) treat an unresolvable
 * static `import('@opentelemetry/api')` as a fatal error when the peer is
 * absent, so the framework integrations mark this specifier **external** (they
 * do NOT alias it to an empty stub — that would permanently disable tracing).
 * External keeps the build green and still loads the real OTel API at runtime
 * when the peer is present.
 */
export const WORKFLOW_OPTIONAL_OTEL_API_MODULE = '@opentelemetry/api';
