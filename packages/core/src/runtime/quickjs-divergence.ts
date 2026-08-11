import { ReplayDivergenceError } from '@workflow/errors';
import type { Event } from '@workflow/world';

/**
 * Replay-divergence arbitration for the QuickJS engine.
 *
 * The node:vm engine detects a corrupted / diverged event log through its
 * `EventsConsumer`: every event must be *claimed* by a consumer registered by
 * the replaying workflow code, consumers validate identity fields
 * (`stepName`, hook `token`, wait `resumeAt`), and an event nobody claims is
 * escalated as `ReplayDivergenceError` — which `runtime.ts` turns into
 * bounded recovery replays and, past the budget, a terminal
 * `CorruptedEventLogError`.
 *
 * The QuickJS engine has no consumer registry: the host feeds events into VM
 * heap structures keyed by correlation id. Before this module existed, a log
 * the replay did not reproduce was absorbed silently — a `step_completed`
 * for a different step's ordinal resolved the wrong call with the wrong
 * payload (no `stepName` check), and events for correlation ids the replay
 * never drew sat in dead buffers while `run_completed` was written over the
 * unreproduced log. The same corruption class the node engine reports as
 * `CORRUPTED_EVENT_LOG` therefore surfaced on QuickJS as `USER_ERROR`
 * (e.g. a self-`HookConflictError`) or as a silently wrong completion.
 *
 * `findReplayDivergence` closes that gap. It runs against the replay's
 * *fixed point* — the moment the VM's job queue is fully drained and no more
 * progress is possible — which is a stronger position than the node engine
 * ever gets to check from: there is no in-flight cross-realm microtask work
 * to wait out, so no grace window or delivery-idle heuristic is needed. The
 * caller dumps the VM's known operations (every correlation id the replay
 * drew, with identity fields) and this function arbitrates the observed
 * event log against them.
 */

/** One operation the replaying VM has drawn a correlation id for. */
export interface VmKnownOp {
  correlationId: string;
  /** `step` | `wait` | `hook` | `hook_dispose` | `attribute` (open set). */
  type: string;
  /** Step operations: the full step id (`step//<module>//<name>`). */
  stepId?: string;
  /** Hook operations: the user-supplied (or system-derived) token. */
  token?: string;
  /** Wait operations: the ISO resume timestamp the VM computed. */
  resumeAt?: string;
}

/**
 * The replay's view of its own draws at a fixed point, dumped from the VM.
 */
export interface VmReplayView {
  ops: VmKnownOp[];
  /** Correlation ids registered in `globalThis.__hooks` (hook machinery). */
  hookCids?: string[];
  /** Correlation ids registered in `globalThis.__abortSignals`. */
  abortCids?: string[];
}

/** The operation family an event type must be claimed by. */
function expectedFamilies(eventType: string): string[] | null {
  if (eventType.startsWith('step_')) return ['step'];
  if (eventType.startsWith('wait_')) return ['wait'];
  if (eventType.startsWith('hook_')) return ['hook', 'hook_dispose'];
  if (eventType === 'attr_set') return ['attribute'];
  return null;
}

function eventDataOf(event: Event): Record<string, unknown> | undefined {
  return 'eventData' in event && event.eventData
    ? (event.eventData as Record<string, unknown>)
    : undefined;
}

/**
 * Events that need no claim from workflow code (parity with the node
 * engine's structural lifecycle consumer in workflow.ts): run lifecycle
 * events, attribute writes not performed by the workflow body, and anything
 * without a correlation id or outside the families the engines track.
 */
function isStructural(event: Event): boolean {
  if (!event.correlationId) return true;
  if (event.eventType.startsWith('run_')) return true;
  if (event.eventType === 'attr_set') {
    const writer = eventDataOf(event)?.writer as { type?: string } | undefined;
    if (writer?.type !== 'workflow') return true;
  }
  return expectedFamilies(event.eventType) === null;
}

/**
 * Arbitrate the observed event log against the replay's fixed-point view.
 * Returns the first divergence in log order, or `null` when the replay
 * reproduced the log. Divergences, in the order they are checked per event:
 *
 *  1. **Orphaned event** — the log contains a correlation id this replay
 *     never drew. Mirrors the node engine's unconsumed-event check
 *     (`onUnconsumedEvent` → workflow.ts).
 *  2. **Family mismatch** — the correlation id exists but belongs to a
 *     different kind of operation (a `step_*` event for a cid the replay
 *     drew as a wait, etc.). Mirrors the node consumers' unexpected-event
 *     checks.
 *  3. **Identity mismatch** — the correlation id and family match but the
 *     recorded identity differs from what this replay derived: a step
 *     event's `stepName` (step.ts), a hook event's `token` (hook.ts), or a
 *     `wait_completed`'s `resumeAt` (sleep.ts).
 */
export function findReplayDivergence(
  events: readonly Event[],
  view: VmReplayView
): ReplayDivergenceError | null {
  const opsByCid = new Map<string, VmKnownOp[]>();
  for (const op of view.ops) {
    const list = opsByCid.get(op.correlationId);
    if (list) {
      list.push(op);
    } else {
      opsByCid.set(op.correlationId, [op]);
    }
  }
  const auxCids = new Set<string>([
    ...(view.hookCids ?? []),
    ...(view.abortCids ?? []),
  ]);

  for (const event of events) {
    if (isStructural(event)) continue;
    const divergence = arbitrateEvent(event, opsByCid, auxCids);
    if (divergence) return divergence;
  }

  return null;
}

function arbitrateEvent(
  event: Event,
  opsByCid: Map<string, VmKnownOp[]>,
  auxCids: Set<string>
): ReplayDivergenceError | null {
  const cid = event.correlationId as string;
  const families = expectedFamilies(event.eventType) as string[];
  const ops = opsByCid.get(cid);

  if (ops === undefined || ops.length === 0) {
    // Hook machinery can know a cid the pending list does not (defensive;
    // the bootstrap pushes a pending op for every draw today).
    if (families.includes('hook') && auxCids.has(cid)) return null;
    return new ReplayDivergenceError(
      `Replay could not consume event: eventType=${event.eventType}, correlationId=${cid}, eventId=${event.eventId}.`,
      { eventId: event.eventId }
    );
  }

  const familyOps = ops.filter((op) => families.includes(op.type));
  if (familyOps.length === 0) {
    return new ReplayDivergenceError(
      `Replay divergence: event ${event.eventType} for ${cid} does not match the "${ops[0].type}" operation the replay drew for that correlation id`,
      { eventId: event.eventId }
    );
  }

  return findIdentityMismatch(event, families, familyOps);
}

/**
 * Identity validation for an event whose correlation id and family both
 * matched a VM operation: the recorded identity fields must equal what this
 * replay derived. Mirrors the node consumers' checks in step.ts, hook.ts
 * and sleep.ts.
 */
function findIdentityMismatch(
  event: Event,
  families: string[],
  familyOps: VmKnownOp[]
): ReplayDivergenceError | null {
  if (families.includes('step')) {
    return findStepNameMismatch(event, familyOps[0]);
  }
  if (families.includes('hook')) {
    return findHookTokenMismatch(event, familyOps);
  }
  if (event.eventType === 'wait_completed') {
    return findResumeAtMismatch(event, familyOps[0]);
  }
  return null;
}

function findStepNameMismatch(
  event: Event,
  op: VmKnownOp
): ReplayDivergenceError | null {
  const eventStepName = eventDataOf(event)?.stepName;
  if (
    typeof eventStepName === 'string' &&
    typeof op.stepId === 'string' &&
    eventStepName !== op.stepId
  ) {
    return new ReplayDivergenceError(
      `Replay divergence: step event ${event.eventType} for ${event.correlationId} belongs to "${eventStepName}", but the current step consumer is "${op.stepId}"`,
      { eventId: event.eventId }
    );
  }
  return null;
}

function findHookTokenMismatch(
  event: Event,
  familyOps: VmKnownOp[]
): ReplayDivergenceError | null {
  const eventToken = eventDataOf(event)?.token;
  const op = familyOps.find((o) => typeof o.token === 'string');
  if (
    typeof eventToken === 'string' &&
    op !== undefined &&
    eventToken !== op.token
  ) {
    return new ReplayDivergenceError(
      `Replay divergence: hook event ${event.eventType} for ${event.correlationId} belongs to token "${eventToken}", but the current hook consumer expects "${op.token}"`,
      { eventId: event.eventId }
    );
  }
  return null;
}

function findResumeAtMismatch(
  event: Event,
  op: VmKnownOp
): ReplayDivergenceError | null {
  const eventResumeAt = eventDataOf(event)?.resumeAt;
  if (eventResumeAt === undefined || typeof op.resumeAt !== 'string') {
    return null;
  }
  const eventMs = new Date(eventResumeAt as string | Date).getTime();
  const expectedMs = new Date(op.resumeAt).getTime();
  if (eventMs !== expectedMs) {
    const eventForMessage = Number.isFinite(eventMs)
      ? new Date(eventMs).toISOString()
      : String(eventResumeAt);
    return new ReplayDivergenceError(
      `Replay divergence: wait_completed event for ${event.correlationId} has resumeAt "${eventForMessage}", but the current wait consumer expects "${new Date(op.resumeAt).toISOString()}"`,
      { eventId: event.eventId }
    );
  }
  return null;
}
