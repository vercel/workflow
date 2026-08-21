/**
 * Minimal telemetry utilities for world-local package.
 *
 * NOTE: This module is a simplified version of world-vercel's telemetry.
 * It provides tracing capabilities for local development to match
 * the observability experience in production.
 *
 * IMPORTANT: This module uses the same tracer name 'workflow' as @workflow/core to ensure
 * all spans are reported under the parent application's service, not as a separate service.
 */
import type * as api from '@opentelemetry/api';
import type { Span, SpanKind, SpanOptions } from '@opentelemetry/api';
import { globalSingleton } from '@workflow/utils';

/**
 * This module's process-wide state: the OpenTelemetry API, imported lazily so
 * it stays optional, and the tracer built from it.
 *
 * On `globalThis` rather than at module scope because a bundler can put several
 * copies of this file in one process (see `globalSingleton`), which would
 * import the API and build a tracer once per copy.
 */
const otel = globalSingleton('@workflow/world-local//telemetry', 1, () => ({
  apiPromise: null as Promise<typeof api | null> | null,
  tracerPromise: null as Promise<api.Tracer | null> | null,
}));

async function getOtelApi(): Promise<typeof api | null> {
  if (!otel.apiPromise) {
    // Static specifier is intentional: esbuild-bundled targets (the CLI's
    // `vercel-build-output-api` build, Nitro, Astro) ship a self-contained
    // bundle with no node_modules, so `@opentelemetry/api` (an optional peer)
    // must be inlined at build time — a runtime-built specifier is opaque to
    // esbuild and would silently disable tracing there. Bundlers that reject
    // an unresolvable static `import()` when the peer is absent (Rollup/Vite,
    // e.g. SvelteKit) externalize it in the framework integration instead.
    otel.apiPromise = import('@opentelemetry/api').catch(() => null);
  }
  return otel.apiPromise;
}

async function getTracer(): Promise<api.Tracer | null> {
  if (!otel.tracerPromise) {
    otel.tracerPromise = getOtelApi().then((otelApi) =>
      otelApi ? otelApi.trace.getTracer('workflow') : null
    );
  }
  return otel.tracerPromise;
}

/**
 * Wrap an async function with a trace span.
 * No-op if OpenTelemetry is not available.
 */
export async function trace<T>(
  spanName: string,
  ...args:
    | [fn: (span?: Span) => Promise<T>]
    | [opts: SpanOptions, fn: (span?: Span) => Promise<T>]
): Promise<T> {
  const [tracer, otel] = await Promise.all([getTracer(), getOtelApi()]);
  const { fn, opts } =
    typeof args[0] === 'function'
      ? { fn: args[0], opts: {} }
      : { fn: args[1], opts: args[0] };
  if (!fn) throw new Error('Function to trace must be provided');

  if (!tracer || !otel) {
    return await fn();
  }

  return tracer.startActiveSpan(spanName, opts, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: otel.SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.setStatus({
        code: otel.SpanStatusCode.ERROR,
        message: (e as Error).message,
      });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * Get SpanKind enum value by name.
 * Returns undefined if OpenTelemetry is not available.
 */
export async function getSpanKind(
  field: keyof typeof SpanKind
): Promise<SpanKind | undefined> {
  const otel = await getOtelApi();
  if (!otel) return undefined;
  return otel.SpanKind[field];
}

// Semantic conventions for World/Storage tracing
// Standard OTEL conventions for peer service mapping
function SemanticConvention<T>(...names: string[]) {
  return (value: T) =>
    Object.fromEntries(names.map((name) => [name, value] as const));
}

/** The remote service name for Datadog service maps (Datadog-specific: peer.service) */
export const PeerService = SemanticConvention<string>('peer.service');

/** RPC system identifier (standard OTEL: rpc.system) */
export const RpcSystem = SemanticConvention<string>('rpc.system');

/** RPC service name (standard OTEL: rpc.service) */
export const RpcService = SemanticConvention<string>('rpc.service');

/** RPC method name (standard OTEL: rpc.method) */
export const RpcMethod = SemanticConvention<string>('rpc.method');

/** Unique identifier for a specific workflow run instance */
export const WorkflowRunId = SemanticConvention<string>('workflow.run.id');

/** Unique identifier for the step instance */
export const StepId = SemanticConvention<string>('step.id');
