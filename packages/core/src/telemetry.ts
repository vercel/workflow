import type * as api from '@opentelemetry/api';
import type { Span, SpanKind, SpanOptions } from '@opentelemetry/api';
import { once } from '@workflow/utils';

// ============================================================
// Trace Context Propagation Utilities
// ============================================================

/**
 * Serializes the current trace context into a format that can be passed through queues
 * @returns A record of strings representing the trace context
 */
export async function serializeTraceCarrier(): Promise<Record<string, string>> {
  const otel = await OtelApi.value;
  if (!otel) return {};
  const carrier: Record<string, string> = {};
  // Inject the current context into the carrier
  otel.propagation.inject(otel.context.active(), carrier);
  return carrier;
}

/**
 * Deserializes trace context and returns a context that can be used to continue the trace
 * @param traceCarrier The serialized trace context
 * @returns OpenTelemetry context with the restored trace
 */
export async function deserializeTraceCarrier(
  traceCarrier: Record<string, string>
) {
  const otel = await OtelApi.value;
  if (!otel) return;
  // Extract the context from the carrier
  return otel.propagation.extract(otel.context.active(), traceCarrier);
}

/**
 * Runs a function within the context of a deserialized trace
 * @param traceCarrier The serialized trace carrier (optional)
 * @param fn The function to run within the trace context
 * @returns The result of the function
 */
export async function withTraceContext<T>(
  traceCarrier: Record<string, string> | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!traceCarrier) {
    return fn();
  }

  const otel = await OtelApi.value;
  if (!otel) return fn();

  const extractedContext = await deserializeTraceCarrier(traceCarrier);
  if (!extractedContext) {
    return fn();
  }

  return otel.context.with(extractedContext, async () => await fn());
}

const OtelApi = once(async () => {
  try {
    return await import('@opentelemetry/api');
  } catch {
    console.warn('OpenTelemetry not available, tracing will be disabled');
    return null;
  }
});

const Tracer = once(async () => {
  const api = await OtelApi.value;
  if (!api) return null;
  return api.trace.getTracer('workflow');
});

export async function trace<T>(
  spanName: string,
  ...args:
    | [fn: (span?: Span) => Promise<T>]
    | [opts: SpanOptions, fn: (span?: Span) => Promise<T>]
): Promise<T> {
  const [tracer, otel] = await Promise.all([Tracer.value, OtelApi.value]);
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

export async function getSpanContextForTraceCarrier(
  carrier: Record<string, string>
) {
  const [deserialized, otel] = await Promise.all([
    deserializeTraceCarrier(carrier),
    OtelApi.value,
  ]);
  if (!deserialized || !otel) return;
  return otel.trace.getSpanContext(deserialized);
}

export async function getActiveSpan() {
  return await withOtel((otel) => otel.trace.getActiveSpan());
}

export function instrumentObject<T extends object>(prefix: string, o: T): T {
  const handlers = {} as T;
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (typeof o[key] !== 'function') {
      handlers[key] = o[key];
    } else {
      const f = o[key];
      // @ts-expect-error
      handlers[key] = async (...args: any[]) =>
        trace(`${prefix}.${String(key)}`, {}, () => f(...args));
    }
  }
  return handlers;
}

export async function getSpanKind(field: keyof typeof SpanKind) {
  return withOtel((x) => x.SpanKind[field]);
}

export async function withOtel<T>(
  fn: (otel: typeof api) => T
): Promise<Awaited<T> | undefined> {
  const otel = await OtelApi.value;
  if (!otel) return undefined;
  return await fn(otel);
}

export function linkToCurrentContext(): Promise<[api.Link] | undefined> {
  return withOtel((otel): [api.Link] | undefined => {
    const context = otel.trace.getActiveSpan()?.spanContext();
    if (!context) return;
    return [{ context }];
  });
}
