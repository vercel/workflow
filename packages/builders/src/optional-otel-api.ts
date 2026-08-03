/**
 * `@opentelemetry/api` is an optional peer dependency of the Workflow SDK: the
 * runtime imports it lazily inside a try/catch so tracing is a no-op when it
 * isn't installed. Rollup/Vite (e.g. SvelteKit's build) treat an unresolvable
 * static `import('@opentelemetry/api')` as a fatal error when the peer is
 * absent, so the framework integrations mark this specifier **external only
 * when it can't be resolved** (they do NOT alias it to an empty stub — that
 * would permanently disable tracing). When the peer IS installed it resolves
 * and bundles normally, which matters for self-contained outputs (Nitro's
 * `.output/server`, esbuild) that ship no node_modules and would otherwise
 * strand the runtime import. External-when-absent keeps the build green.
 */
export const WORKFLOW_OPTIONAL_OTEL_API_MODULE = '@opentelemetry/api';
