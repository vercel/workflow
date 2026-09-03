import { globalSingleton } from '@workflow/utils';
import type { TelemetrySettings } from './durable-agent.js';

// Minimal OTel type shims so we don't depend on @opentelemetry/api at compile time.
type Attributes = Record<string, unknown>;

type Span = {
  setAttributes(attributes: Attributes): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: {
    name: string;
    message: string;
    stack?: string;
  }): void;
  end(): void;
};

type Context = unknown;

type Tracer = {
  startActiveSpan<T>(
    name: string,
    options: Attributes,
    fn: (span: Span) => T
  ): T;
  startSpan(name: string, options?: Attributes, context?: Context): Span;
};

// Full OTel API surface we use
interface OtelApi {
  trace: {
    getTracer(name: string): Tracer;
    setSpan(context: Context, span: Span): Context;
  };
  context: {
    active(): Context;
    with<T>(ctx: Context, fn: () => T): T;
  };
  SpanStatusCode: { ERROR: number };
}

// Lazy-loaded OTel API: self-initializes on first use (item 5).
//
// On `globalThis` rather than at module scope because this package is bundled
// into the host application's server build, which gives one copy of this module
// per bundler layer; per-copy state would re-attempt the import once per layer.
const otel = globalSingleton('@workflow/ai//agentTelemetry', 1, () => ({
  api: null as OtelApi | null,
  loadAttempted: false,
}));

async function ensureOtelApi(): Promise<OtelApi | null> {
  if (otel.loadAttempted) return otel.api;
  otel.loadAttempted = true;
  try {
    // Dynamic import, since @opentelemetry/api is an optional peer dependency.
    // Use Function() to hide the import from bundlers that would fail at
    // compile time when the package is absent.
    otel.api = await (Function(
      'return import("@opentelemetry/api")'
    )() as Promise<OtelApi>);
  } catch {
    otel.api = null;
  }
  return otel.api;
}

/**
 * Stateless tracer accessor matching AI SDK's `getTracer` pattern (item 5).
 * Returns a no-op–equivalent `null` when telemetry is disabled, so callers
 * don't need a separate init step.
 */
function getTracer(telemetry?: TelemetrySettings): Tracer | null {
  if (!telemetry?.isEnabled || !otel.api) return null;
  if (telemetry.tracer) return telemetry.tracer as Tracer;
  return otel.api.trace.getTracer('ai');
}

// ── Attribute helpers ──────────────────────────────────────────────────

/**
 * Assemble `operation.name` / `resource.name` following the AI SDK convention
 * (items 1 + 2): separator is a **space**, not a dot.
 */
function assembleOperationName(
  operationId: string,
  telemetry?: TelemetrySettings
): Attributes {
  return {
    'operation.name': `${operationId}${
      telemetry?.functionId != null ? ` ${telemetry.functionId}` : ''
    }`,
    'resource.name': telemetry?.functionId,
    'ai.operationId': operationId,
    'ai.telemetry.functionId': telemetry?.functionId,
  };
}

/**
 * Build the full attribute bag for a span, merging operation name,
 * caller-supplied attributes, and user-defined telemetry metadata.
 */
function buildAttributes(
  operationId: string,
  telemetry: TelemetrySettings | undefined,
  extra?: Attributes
): Attributes {
  if (!telemetry?.isEnabled) return {};

  const attrs: Attributes = {
    ...assembleOperationName(operationId, telemetry),
    ...extra,
  };

  if (telemetry.metadata) {
    for (const [key, value] of Object.entries(telemetry.metadata)) {
      if (value != null) {
        attrs[`ai.telemetry.metadata.${key}`] = value;
      }
    }
  }

  return attrs;
}

// ── Error recording (item 3) ───────────────────────────────────────────

/**
 * Record an error on a span following the AI SDK pattern:
 * `recordException` (with name / message / stack) + `setStatus`.
 */
function recordErrorOnSpan(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    span.setStatus({
      code: otel.api?.SpanStatusCode.ERROR ?? 2,
      message: error.message,
    });
  } else {
    span.setStatus({ code: otel.api?.SpanStatusCode.ERROR ?? 2 });
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export type { Span };

/**
 * A handle returned by `createSpan` containing both the span and the OTel
 * context with that span set as active. Callers should use `runInContext`
 * to execute code "within" this span so that nested spans parent correctly.
 */
export interface SpanHandle {
  span: Span;
  context: Context;
}

/**
 * Record a span around an async function.
 *
 * Self-initialising: the first call lazily loads `@opentelemetry/api`.
 * If telemetry is disabled or OTel is unavailable the `fn` runs without
 * instrumentation (no-op fast path).
 *
 * Matches the AI SDK's `recordSpan`:
 * - Uses `context.with()` for proper context propagation (item 4)
 * - Calls `recordException` + `setStatus` on errors (item 3)
 * - Uses space separator in `operation.name` (item 1)
 * - Sets `resource.name` (item 2)
 */
export async function recordSpan<T>(options: {
  name: string;
  telemetry?: TelemetrySettings;
  attributes?: Attributes;
  fn: (span?: Span) => PromiseLike<T> | T;
}): Promise<T> {
  // Self-initialize on first call (item 5)
  if (!otel.loadAttempted) {
    await ensureOtelApi();
  }

  const tracer = getTracer(options.telemetry);
  if (!tracer || !otel.api) {
    return options.fn(undefined);
  }

  const attrs = buildAttributes(
    options.name,
    options.telemetry,
    options.attributes
  );

  return tracer.startActiveSpan(
    options.name,
    { attributes: attrs },
    async (span) => {
      // Capture current context so nested spans parent correctly (item 4).
      // otel.api is guaranteed non-null here (checked before startActiveSpan).
      const ctx = otel.api!.context.active();

      try {
        const result = await otel.api!.context.with(ctx, () =>
          options.fn(span)
        );
        span.end();
        return result;
      } catch (error) {
        try {
          recordErrorOnSpan(span, error);
        } finally {
          span.end();
        }
        throw error;
      }
    }
  );
}

/**
 * Manually create and start a span. The caller is responsible for ending it.
 *
 * Use this when the span must stay open across yield boundaries (e.g. in
 * async generators) where `recordSpan`'s callback pattern doesn't work.
 *
 * Returns a `SpanHandle` containing the span and the OTel context with the
 * span set as active. Use `runInContext(handle, fn)` to execute code within
 * this span so that nested spans (e.g. `recordSpan` calls) parent correctly.
 *
 * Returns `undefined` if telemetry is disabled or OTel is unavailable.
 */
export async function createSpan(options: {
  name: string;
  telemetry?: TelemetrySettings;
  attributes?: Attributes;
}): Promise<SpanHandle | undefined> {
  if (!otel.loadAttempted) {
    await ensureOtelApi();
  }

  const tracer = getTracer(options.telemetry);
  if (!tracer || !otel.api) return undefined;

  const attrs = buildAttributes(
    options.name,
    options.telemetry,
    options.attributes
  );

  // Capture the active context so the span parents under the caller's
  // current span, matching how recordSpan uses context.with().
  const parentCtx = otel.api.context.active();
  const span = tracer.startSpan(options.name, { attributes: attrs }, parentCtx);
  const context = otel.api.trace.setSpan(parentCtx, span);
  return { span, context };
}

/**
 * Execute `fn` with the given span's context as the active OTel context.
 *
 * This ensures that any spans created inside `fn` (e.g. via `recordSpan`)
 * will parent under the span in `handle`. For generators, wrap each
 * iteration's async work individually since `context.with` doesn't
 * propagate across yield boundaries.
 *
 * If `handle` is undefined (telemetry disabled), `fn` runs directly.
 */
export function runInContext<T>(
  handle: SpanHandle | undefined,
  fn: () => T
): T {
  if (!handle || !otel.api) return fn();
  return otel.api.context.with(handle.context, fn);
}

/**
 * Safely end a span, recording an error if one occurred.
 * Defensive: telemetry failures never propagate to the caller.
 */
export function endSpan(span: Span | undefined, error?: unknown): void {
  if (!span) return;
  try {
    if (error) {
      recordErrorOnSpan(span, error);
    }
  } finally {
    try {
      span.end();
    } catch {
      /* best effort */
    }
  }
}
