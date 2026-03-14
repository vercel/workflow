import type { TelemetrySettings } from './durable-agent.js';

type Tracer = {
  startActiveSpan<T>(
    name: string,
    options: Record<string, unknown>,
    fn: (span: Span) => T
  ): T;
};

type Span = {
  setAttributes(attributes: Record<string, unknown>): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
};

// Lazy-loaded OTel API
let otelApi: {
  trace: { getTracer(name: string): Tracer };
  SpanStatusCode: { ERROR: number };
  SpanKind: { INTERNAL: number };
} | null = null;
let otelLoadAttempted = false;

async function getOtelApi() {
  if (otelLoadAttempted) return otelApi;
  otelLoadAttempted = true;
  try {
    // Dynamic import - @opentelemetry/api is an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    otelApi = await (Function(
      'return import("@opentelemetry/api")'
    )() as Promise<typeof otelApi>);
  } catch {
    otelApi = null;
  }
  return otelApi;
}

function getTracer(telemetry?: TelemetrySettings): Tracer | null {
  if (!telemetry?.isEnabled || !otelApi) return null;
  if (telemetry.tracer) return telemetry.tracer as Tracer;
  return otelApi.trace.getTracer('ai');
}

function buildAttributes(
  telemetry: TelemetrySettings | undefined,
  baseAttributes: Record<string, unknown>
): Record<string, unknown> {
  if (!telemetry?.isEnabled) return {};
  const attrs: Record<string, unknown> = { ...baseAttributes };
  if (telemetry.functionId) {
    attrs['ai.telemetry.functionId'] = telemetry.functionId;
    attrs['operation.name'] =
      `${baseAttributes['operation.name'] ?? baseAttributes['ai.operationId'] ?? 'ai.streamText'}.${telemetry.functionId}`;
  }
  if (telemetry.metadata) {
    for (const [key, value] of Object.entries(telemetry.metadata)) {
      if (value != null) {
        attrs[`ai.telemetry.metadata.${key}`] = value;
      }
    }
  }
  return attrs;
}

/**
 * Initialize telemetry by attempting to load @opentelemetry/api.
 * Must be called before using other telemetry functions.
 * Returns true if OTel is available and telemetry is enabled.
 */
export async function initTelemetry(
  telemetry?: TelemetrySettings
): Promise<boolean> {
  if (!telemetry?.isEnabled) return false;
  const api = await getOtelApi();
  return api != null;
}

/**
 * Record a span around an async function.
 * If telemetry is disabled or OTel is unavailable, the function runs without instrumentation.
 */
export async function recordSpan<T>(options: {
  name: string;
  telemetry?: TelemetrySettings;
  attributes?: Record<string, unknown>;
  fn: (span?: Span) => PromiseLike<T> | T;
}): Promise<T> {
  const tracer = getTracer(options.telemetry);
  if (!tracer || !otelApi) {
    return options.fn(undefined);
  }

  const attrs = buildAttributes(options.telemetry, {
    'ai.operationId': options.name,
    'operation.name': options.name,
    ...options.attributes,
  });

  return tracer.startActiveSpan(
    options.name,
    { kind: otelApi.SpanKind.INTERNAL, attributes: attrs },
    async (span) => {
      try {
        const result = await options.fn(span);
        return result;
      } catch (error) {
        span.setStatus({
          code: otelApi?.SpanStatusCode.ERROR ?? 2,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
