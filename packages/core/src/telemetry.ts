import type * as api from '@opentelemetry/api';
import type { Span, SpanKind, SpanOptions } from '@opentelemetry/api';
import { once } from '@workflow/utils';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import * as Attr from './telemetry/semantic-conventions.js';

// ============================================================
// Trace Context Propagation Utilities
// ============================================================

/**
 * Controls how workflow/step queue-handler spans relate to the run-origin
 * trace context carried in queue messages:
 *
 * - `'linked'` (default): each invocation starts a NEW root trace; the
 *   run-origin context (and the incoming delivery context) are attached as
 *   span links. This keeps traces bounded per invocation instead of
 *   stitching a long-lived run into one giant trace.
 * - `'continuous'`: the restored run-origin context becomes the parent of
 *   the invocation span (legacy behavior), producing a single trace that
 *   spans the entire run.
 */
export type WorkflowTraceMode = 'linked' | 'continuous';

/** Unrecognized `WORKFLOW_TRACE_MODE` values we already warned about. */
const warnedUnrecognizedTraceModes = new Set<string>();

/**
 * Resolves the active trace mode from the `WORKFLOW_TRACE_MODE` env var.
 * Defaults to `'linked'`; any value other than `'continuous'` selects it.
 * Unrecognized non-empty values (e.g. typos like `continous`) emit a
 * one-time warning so silent fallback to `linked` is at least visible.
 */
export function getWorkflowTraceMode(): WorkflowTraceMode {
  const value = process.env.WORKFLOW_TRACE_MODE;
  if (value === 'continuous') return 'continuous';
  if (value && value !== 'linked' && !warnedUnrecognizedTraceModes.has(value)) {
    warnedUnrecognizedTraceModes.add(value);
    runtimeLogger.warn(
      `Unrecognized WORKFLOW_TRACE_MODE value "${value}"; expected "linked" or "continuous". Falling back to "linked".`
    );
  }
  return 'linked';
}

/**
 * Returns whether a serialized trace carrier is usable, i.e. present and
 * non-empty. `serializeTraceCarrier()` returns `{}` when no OTEL SDK is
 * registered or no span is active, and `start()` always attaches the
 * carrier to the first queue message — so an empty carrier must be treated
 * the same as an absent one wherever the trace-mode logic branches.
 */
export function isUsableTraceCarrier(
  carrier: Record<string, string> | undefined
): carrier is Record<string, string> {
  return carrier !== undefined && Object.keys(carrier).length > 0;
}

/**
 * Returns the trace carrier to attach to messages the current invocation
 * enqueues. In `linked` mode the ORIGINAL run-origin carrier is forwarded
 * unchanged (when usable) so every future invocation links back to the same
 * origin; otherwise — `continuous` mode, or no usable incoming carrier —
 * the current (active) context is serialized, so the trace keeps chaining
 * (continuous) or the first instrumented invocation becomes the de-facto
 * origin (linked).
 */
export function getNextTraceCarrier(
  traceMode: WorkflowTraceMode,
  incomingCarrier: Record<string, string> | undefined
): Promise<Record<string, string>> {
  return traceMode === 'linked' && isUsableTraceCarrier(incomingCarrier)
    ? Promise.resolve(incomingCarrier)
    : serializeTraceCarrier();
}

/**
 * Builds the span links for a queue-delivered invocation span
 * (`workflow.execute` / `step.execute`):
 *
 * - In `linked` mode the invocation span is a CHILD of the local delivery
 *   (flow-route) context, so the only link is to the run-origin context
 *   from the message's trace carrier — connecting this bounded per-invocation
 *   trace back to where the run was started. The run-origin context is a
 *   link, never a parent, and re-enqueues forward the original carrier
 *   unchanged, so the whole run is never stitched into one giant trace.
 *   The link is skipped when the carrier is absent, empty, or invalid.
 * - In `continuous` mode the run-origin context is restored as the parent
 *   instead, and the link points at the incoming delivery context.
 */
export async function buildInvocationSpanLinks(
  traceMode: WorkflowTraceMode,
  incomingCarrier: Record<string, string> | undefined
): Promise<api.Link[] | undefined> {
  if (traceMode !== 'linked') return linkToCurrentContext();
  const originLink = await linkToTraceCarrier(
    isUsableTraceCarrier(incomingCarrier) ? incomingCarrier : undefined
  );
  return originLink ? [originLink] : undefined;
}

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
  // `@opentelemetry/api` is an optional peer dependency. The static specifier
  // is intentional: esbuild-bundled targets (the CLI's
  // `vercel-build-output-api` build, Nitro, Astro) ship a self-contained
  // bundle with no node_modules, so the package must be *inlined* at build
  // time for spans to work at runtime — a runtime-built specifier is opaque to
  // esbuild and would silently disable tracing there. Bundlers that reject an
  // unresolvable static `import()` when the peer isn't installed (Rollup/Vite,
  // e.g. SvelteKit) instead externalize `@opentelemetry/api` in the workflow
  // framework integration, which keeps the build green and still loads real
  // OTel when the peer is present. Runtime semantics: present → loaded, absent
  // → caught and tracing disabled.
  try {
    return await import('@opentelemetry/api');
  } catch {
    runtimeLogger.info('OpenTelemetry not available, tracing will be disabled');
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
      applyWorkflowSuspensionToSpan(e, otel, span);
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * Emit a span whose start is back-dated to `startEpochMs` and whose end is now,
 * so its duration reflects an interval only measurable at its end (e.g.
 * time-to-first-chunk, known when the first chunk arrives). Unlike `trace()`,
 * this records an already-elapsed span in one shot rather than wrapping a
 * callback. No-op when OpenTelemetry is not available.
 */
export async function recordElapsedSpan(
  spanName: string,
  startEpochMs: number,
  opts?: SpanOptions
): Promise<void> {
  const tracer = await Tracer.value;
  if (!tracer) return;
  tracer.startSpan(spanName, { ...opts, startTime: startEpochMs }).end();
}

/**
 * Applies workflow suspension attributes to the given span if the error is a WorkflowSuspension
 * which is technically not an error, but an algebraic effect indicating suspension.
 */
function applyWorkflowSuspensionToSpan(
  error: unknown,
  otel: typeof api,
  span: api.Span
) {
  if (!error || !WorkflowSuspension.is(error)) {
    return;
  }

  span.setStatus({ code: otel.SpanStatusCode.OK });
  span.setAttributes({
    ...Attr.WorkflowSuspensionState('suspended'),
    ...Attr.WorkflowSuspensionStepCount(error.stepCount),
    ...Attr.WorkflowSuspensionHookCount(error.hookCount),
    ...Attr.WorkflowSuspensionWaitCount(error.waitCount),
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

/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "WORLD.runs")
 * @param o - Object with methods to instrument
 * @returns Instrumented object with same interface
 */
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

/**
 * Builds a span link pointing at the span context embedded in a serialized
 * trace carrier (e.g. the run-origin context flowing through queue
 * messages). Returns `undefined` when OTEL is unavailable, the carrier is
 * absent, or it does not contain a valid span context.
 */
export async function linkToTraceCarrier(
  carrier: Record<string, string> | undefined
): Promise<api.Link | undefined> {
  if (!carrier) return;
  const [context, otel] = await Promise.all([
    getSpanContextForTraceCarrier(carrier),
    OtelApi.value,
  ]);
  if (!context || !otel) return;
  if (!otel.trace.isSpanContextValid(context)) return;
  return { context };
}

// ============================================================
// Baggage Propagation Utilities
// ============================================================

/**
 * Workflow context to propagate via baggage
 */
export interface WorkflowBaggageContext {
  workflowRunId: string;
  workflowName: string;
}

/**
 * Sets workflow context as OTEL baggage for automatic propagation.
 * Baggage is propagated across service boundaries via HTTP headers.
 * @param context - Workflow context to set as baggage
 * @returns A function to run within the baggage context
 */
export async function withWorkflowBaggage<T>(
  context: WorkflowBaggageContext,
  fn: () => Promise<T>
): Promise<T> {
  const otel = await OtelApi.value;
  if (!otel) return fn();

  // Create baggage with workflow context
  const baggage = otel.propagation.createBaggage({
    'workflow.run_id': { value: context.workflowRunId },
    'workflow.name': { value: context.workflowName },
  });

  // Set baggage in context and run function
  const contextWithBaggage = otel.propagation.setBaggage(
    otel.context.active(),
    baggage
  );

  return otel.context.with(contextWithBaggage, () => fn());
}

/**
 * Retrieves workflow context from OTEL baggage.
 * @returns Workflow context if present in baggage, undefined otherwise
 */
export async function getWorkflowBaggage(): Promise<
  WorkflowBaggageContext | undefined
> {
  const otel = await OtelApi.value;
  if (!otel) return undefined;

  const baggage = otel.propagation.getBaggage(otel.context.active());
  if (!baggage) return undefined;

  const runId = baggage.getEntry('workflow.run_id')?.value;
  const name = baggage.getEntry('workflow.name')?.value;

  if (!runId || !name) return undefined;

  return {
    workflowRunId: runId,
    workflowName: name,
  };
}
