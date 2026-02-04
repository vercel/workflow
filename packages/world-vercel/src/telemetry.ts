/**
 * Minimal telemetry utilities for world-vercel package.
 * This is a simplified version that doesn't depend on @workflow/core to avoid circular dependencies.
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
function SemanticConvention<T>(...names: string[]) {
  return (value: T) =>
    Object.fromEntries(names.map((name) => [name, value] as const));
}

/** HTTP method used in World storage request */
export const WorldHttpMethod = SemanticConvention<string>('world.http.method');

/** API endpoint path for World storage request */
export const WorldHttpEndpoint = SemanticConvention<string>(
  'world.http.endpoint'
);

/** HTTP status code from World storage request */
export const WorldHttpStatus = SemanticConvention<number>('world.http.status');

/** Format used for parsing response body (cbor or json) */
export const WorldParseFormat = SemanticConvention<'cbor' | 'json'>(
  'world.parse.format'
);

/** Size in bytes of the parsed response body */
export const WorldParseBytes = SemanticConvention<number>('world.parse.bytes');
