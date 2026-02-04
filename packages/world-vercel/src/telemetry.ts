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
 */
import type * as api from '@opentelemetry/api';
import type { Span, SpanKind, SpanOptions } from '@opentelemetry/api';

// Lazy load OpenTelemetry API to make it optional
let otelApiPromise: Promise<typeof api | null> | null = null;

async function getOtelApi(): Promise<typeof api | null> {
  if (!otelApiPromise) {
    otelApiPromise = import('@opentelemetry/api').catch(() => null);
  }
  return otelApiPromise;
}

let tracerPromise: Promise<api.Tracer | null> | null = null;

async function getTracer(): Promise<api.Tracer | null> {
  if (!tracerPromise) {
    tracerPromise = getOtelApi().then((otel) =>
      otel ? otel.trace.getTracer('workflow-world-vercel') : null
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
