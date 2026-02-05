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
import type { Span, SpanOptions } from '@opentelemetry/api';

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
