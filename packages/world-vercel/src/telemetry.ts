/**
 * Minimal telemetry utilities for world-vercel package.
 *
 * NOTE: This module intentionally duplicates semantic conventions from @workflow/core
 * to avoid a circular dependency (world-vercel cannot depend on core).
 * If you update conventions here, ensure @workflow/core/telemetry/semantic-conventions.ts
 * remains synchronized.
 *
 * NOTE: Unlike the trace() function in @workflow/core, this implementation does not
 * have special handling for WorkflowSuspension errors because world-vercel operates
 * at the HTTP layer and never encounters workflow suspension effects.
 *
 * IMPORTANT: This module uses the same tracer name 'workflow' as @workflow/core to ensure
 * all spans are reported under the parent application's service, not as a separate service.
 */
import type * as api from '@opentelemetry/api';
import type { Span, SpanKind, SpanOptions } from '@opentelemetry/api';

// Lazy load OpenTelemetry API to make it optional
let otelApiPromise: Promise<typeof api | null> | null = null;

async function getOtelApi(): Promise<typeof api | null> {
  if (!otelApiPromise) {
    // Static specifier is intentional: esbuild-bundled targets (the CLI's
    // `vercel-build-output-api` build, Nitro, Astro) ship a self-contained
    // bundle with no node_modules, so `@opentelemetry/api` (an optional peer)
    // must be inlined at build time — a runtime-built specifier is opaque to
    // esbuild and would silently disable tracing there. Bundlers that reject
    // an unresolvable static `import()` when the peer is absent (Rollup/Vite,
    // e.g. SvelteKit) externalize it in the framework integration instead.
    otelApiPromise = import('@opentelemetry/api').catch(() => null);
  }
  return otelApiPromise;
}

let tracerPromise: Promise<api.Tracer | null> | null = null;

async function getTracer(): Promise<api.Tracer | null> {
  if (!tracerPromise) {
    tracerPromise = getOtelApi().then((otel) =>
      otel ? otel.trace.getTracer('workflow') : null
    );
  }
  return tracerPromise;
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

/**
 * Injects the active trace context into the given request headers using the
 * registered propagator (typically W3C `traceparent`/`tracestate` plus
 * `baggage`). Call inside an active client span so the receiving server can
 * parent its spans to it.
 *
 * No-ops when `@opentelemetry/api` is unavailable or no SDK/propagator is
 * registered (the default no-op propagator injects nothing).
 */
export async function injectTraceContextIntoHeaders(
  headers: Headers
): Promise<void> {
  const otel = await getOtelApi();
  if (!otel) return;
  const carrier: Record<string, string> = {};
  otel.propagation.inject(otel.context.active(), carrier);
  for (const [key, value] of Object.entries(carrier)) {
    headers.set(key, value);
  }
}

// Semantic conventions for World/Storage tracing
// Standard OTEL conventions: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
function SemanticConvention<T>(...names: string[]) {
  return (value: T) =>
    Object.fromEntries(names.map((name) => [name, value] as const));
}

/** HTTP request method (standard OTEL: http.request.method) */
export const HttpRequestMethod = SemanticConvention<string>(
  'http.request.method'
);

/** Full URL of the request (standard OTEL: url.full) */
export const UrlFull = SemanticConvention<string>('url.full');

/** Server hostname (standard OTEL: server.address) */
export const ServerAddress = SemanticConvention<string>('server.address');

/** Server port (standard OTEL: server.port) */
export const ServerPort = SemanticConvention<number>('server.port');

/** HTTP response status code (standard OTEL: http.response.status_code) */
export const HttpResponseStatusCode = SemanticConvention<number>(
  'http.response.status_code'
);

/** Error type when request fails (standard OTEL: error.type) */
export const ErrorType = SemanticConvention<string>('error.type');

/** Format used for parsing response body (cbor or json) */
export const WorldParseFormat = SemanticConvention<'cbor' | 'json'>(
  'workflow.world.parse.format'
);

// RPC/Peer Service attributes - For service maps and dependency tracking
// See: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/

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

/** Name of the stream being written or read (workflow.stream.name) */
export const WorkflowStreamName = SemanticConvention<string>(
  'workflow.stream.name'
);

/**
 * Stream operation performed by the client span
 * (workflow.stream.operation): write | write_multi | close | read.
 */
export const WorkflowStreamOperation = SemanticConvention<string>(
  'workflow.stream.operation'
);

/** Requested start index for a live stream read (workflow.stream.start_index) */
export const WorkflowStreamStartIndex = SemanticConvention<number>(
  'workflow.stream.start_index'
);
