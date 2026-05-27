/**
 * TEMPORARY DEBUG INSTRUMENTATION — DO NOT MERGE TO MAIN.
 *
 * This module emits `console.log` lines tagged with `WF_TRACE` that capture
 * the SDK's view of the event log on every replay, plus the per-invocation
 * stepName ↔ correlationId assignments. Used to diagnose intermittent
 * CorruptedEventLogError "step consumer mismatch" failures in production
 * by diffing the trace lines from successive replays of the same runId.
 *
 * Output format (all on one line, prefixed with `WF_TRACE` for grepping):
 *
 *   WF_TRACE {"k":"replay_start","runId":...,"inv":<id>,"eventCount":N,
 *             "digest":"<sha256-first-16-hex>","events":[...]}
 *   WF_TRACE {"k":"step_subscribe","runId":...,"inv":<id>,"seq":N,
 *             "correlationId":"step_...","stepName":"step//..."}
 *   WF_TRACE {"k":"hook_subscribe","runId":...,"inv":<id>,"seq":N,
 *             "correlationId":"hook_...","token":"..."}
 *   WF_TRACE {"k":"sleep_subscribe","runId":...,"inv":<id>,"seq":N,
 *             "correlationId":"wait_...","resumeAt":"..."}
 *   WF_TRACE {"k":"step_mismatch","runId":...,"inv":<id>,
 *             "correlationId":"step_...","expectedStepName":"...",
 *             "eventStepName":"...","eventId":"evnt_...",
 *             "eventIndex":N,"eventType":"step_created"}
 */
import { createHash } from 'node:crypto';
import type { Event } from '@workflow/world';

let nextInvocationId = 1;

/** A monotonically increasing per-process invocation counter. */
export function nextInv(): number {
  return nextInvocationId++;
}

const SUBSCRIBE_COUNTERS = new WeakMap<object, number>();

/**
 * Returns a per-invocation monotonic counter for subscribe events so we can
 * tell the n-th step/hook/sleep registration apart on a given replay.
 */
function nextSubscribeSeq(invKey: object): number {
  const v = (SUBSCRIBE_COUNTERS.get(invKey) ?? 0) + 1;
  SUBSCRIBE_COUNTERS.set(invKey, v);
  return v;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<unserializable>"';
  }
}

function emit(line: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`WF_TRACE ${safeStringify(line)}`);
  } catch {
    // best-effort — never let diagnostics break the workflow.
  }
}

function eventSummary(event: Event): {
  i: string;
  t: string;
  c?: string;
  n?: string;
  r?: string;
  ca?: string;
} {
  const out: {
    i: string;
    t: string;
    c?: string;
    n?: string;
    r?: string;
    ca?: string;
  } = {
    i: event.eventId,
    t: event.eventType,
  };
  if (event.correlationId !== undefined) {
    out.c = event.correlationId as string;
  }
  // Pull stepName / resumeAt out of eventData if present, but nothing else
  // (we don't want to dump payload bodies).
  const data = (event as { eventData?: Record<string, unknown> }).eventData;
  if (data && typeof data === 'object') {
    if (typeof data.stepName === 'string') {
      out.n = data.stepName;
    }
    if (data.resumeAt !== undefined) {
      out.r = String(data.resumeAt);
    }
  }
  if (event.createdAt) {
    out.ca = new Date(event.createdAt as Date | string).toISOString();
  }
  return out;
}

export function traceReplayStart(
  runId: string,
  workflowName: string,
  invId: number,
  startedAt: Date,
  events: Event[]
): { invKey: object } {
  const summaries = events.map(eventSummary);
  // Stable digest over (eventId|eventType|correlationId) for quick equality
  // testing across replays without dumping the whole list.
  const hash = createHash('sha256');
  for (const e of summaries) {
    hash.update(`${e.i}|${e.t}|${e.c ?? ''}|${e.n ?? ''}\n`);
  }
  const digest = hash.digest('hex').slice(0, 16);
  emit({
    k: 'replay_start',
    runId,
    workflowName,
    inv: invId,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    eventCount: events.length,
    digest,
    events: summaries,
  });
  return { invKey: {} };
}

export function traceReplayEnd(
  runId: string,
  invId: number,
  outcome: 'completed' | 'failed' | 'suspended',
  errorMessage?: string
): void {
  emit({
    k: 'replay_end',
    runId,
    inv: invId,
    outcome,
    error: errorMessage,
  });
}

export function traceStepSubscribe(
  runId: string,
  invKey: object,
  invId: number,
  correlationId: string,
  stepName: string
): void {
  emit({
    k: 'step_subscribe',
    runId,
    inv: invId,
    seq: nextSubscribeSeq(invKey),
    correlationId,
    stepName,
  });
}

export function traceHookSubscribe(
  runId: string,
  invKey: object,
  invId: number,
  correlationId: string,
  token: string
): void {
  emit({
    k: 'hook_subscribe',
    runId,
    inv: invId,
    seq: nextSubscribeSeq(invKey),
    correlationId,
    token,
  });
}

export function traceSleepSubscribe(
  runId: string,
  invKey: object,
  invId: number,
  correlationId: string,
  resumeAt: Date
): void {
  emit({
    k: 'sleep_subscribe',
    runId,
    inv: invId,
    seq: nextSubscribeSeq(invKey),
    correlationId,
    resumeAt: resumeAt.toISOString(),
  });
}

export function traceStepMismatch(
  runId: string,
  invId: number,
  correlationId: string,
  expectedStepName: string,
  eventStepName: string,
  eventId: string,
  eventType: string,
  eventIndex: number
): void {
  emit({
    k: 'step_mismatch',
    runId,
    inv: invId,
    correlationId,
    expectedStepName,
    eventStepName,
    eventId,
    eventType,
    eventIndex,
  });
}

/**
 * Holder object so we can stash the per-invocation invKey + invId on the
 * orchestrator context without changing its public shape. We attach it via
 * a symbol-keyed property on `ctx.invocationsQueue` (a Map) since that's
 * the most convenient existing per-invocation singleton on the context.
 */
export const REPLAY_TRACE_KEY = Symbol.for(
  '__workflow_debug_replay_trace_v1__'
);

export interface ReplayTraceState {
  runId: string;
  invKey: object;
  invId: number;
}

export function attachTraceState(
  ctx: { invocationsQueue: Map<string, unknown> },
  state: ReplayTraceState
): void {
  (ctx.invocationsQueue as unknown as Record<symbol, ReplayTraceState>)[
    REPLAY_TRACE_KEY
  ] = state;
}

export function getTraceState(ctx: {
  invocationsQueue: Map<string, unknown>;
}): ReplayTraceState | undefined {
  return (ctx.invocationsQueue as unknown as Record<symbol, ReplayTraceState>)[
    REPLAY_TRACE_KEY
  ];
}
