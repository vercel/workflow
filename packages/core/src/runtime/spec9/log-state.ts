import type { Event, SerializedData } from '@workflow/world';
import { CHILD_RUN_COMPLETION_TOKEN_PREFIX } from '../child-run-completion.js';

/**
 * Upper bound on a step input carried on its queue message. Larger inputs are
 * read back from the step's `step_created` by the step's invocation. Staying
 * under the queue's inline threshold keeps step messages on its fast path.
 */
export const MAX_STEP_MESSAGE_INPUT_BYTES = 128 * 1024;

/** A background step message to enqueue. */
export interface StepMessageSpec {
  correlationId: string;
  stepName: string;
  stepCreatedEventId?: string;
  /**
   * When the step's `step_created` was committed (its `createdAt`), for a
   * background step's first message. Re-sends carry the creation's time, not
   * the re-send's. Sent only when the message starts at attempt 1.
   */
  stepCreatedAt?: Date;
  input?: SerializedData;
  stepAttempt?: number;
  /**
   * A re-send (see `stepsToReenqueue`): its message is marked, so that its
   * handler reads the log before it runs the body.
   */
  resent?: boolean;
}

/** An inline step to run in this process. */
export interface InlineStepSpec {
  correlationId: string;
  stepName: string;
  input?: SerializedData;
  createdEventId?: string;
  attempt: number;
  firstStartedAt?: Date;
  /**
   * When the step's latest attempt started, for an attempt after one that
   * left no outcome. Reported if that attempt exhausted the retry budget.
   */
  lastStartedAt?: Date;
  /**
   * The step's creation-bearing `step_started`, when the orchestrator wrote
   * it (its creation batch). The executor then writes no start.
   */
  started?: { startedAt: Date; postSentAtMs?: number; completedAtMs?: number };
  /** The World's refusal of that creation-bearing start. */
  startRefusal?: Error;
  /**
   * Settles once the step's creation committed, when the body starts while
   * that commit is in flight (turbo), with its creation-bearing start.
   * Otherwise its `step_started` waits for it.
   */
  startAfter?: Promise<
    | { startedAt: Date; postSentAtMs?: number; completedAtMs?: number }
    | undefined
  >;
}

/** What the log says about one step. */
export interface LogStepState {
  correlationId: string;
  stepName: string;
  createdEventId: string;
  /** The `createdAt` of the step's `step_created`; absent for an inline
   *  step, which a `step_started` creates. */
  createdAt?: Date;
  inline: boolean;
  starts: number;
  /** When the step's first attempt started. */
  firstStartedAt?: Date;
  /** When the step's latest attempt started. */
  lastStartedAt?: Date;
  terminal: boolean;
  /** The step's last event is a `step_retrying`. */
  lastIsRetrying: boolean;
  /**
   * An inline-mode step that is open and has not moved to the background:
   * the current orchestrator runs it (again) in its own process. A
   * `step_retrying` moves it to its own message for good: that message runs
   * every later attempt, so a later attempt's `step_started` does not make
   * it runnable inline again (see {@link awaitsExternalWork}).
   */
  runnableInline: boolean;
}

/**
 * The creation a step event records: a `step_created`, or a creation-bearing
 * `step_started`. A single-orchestrator run (spec >= 9) records an inline
 * step by its first `step_started` alone, with what a `step_created` carries
 * (stepName, workflowName, input, `inline: true`), less `creatorMessageId`. It is
 * told apart by `inline: true`, which no other start carries: a replay page
 * may omit the start's input.
 */
export function stepCreationOf(
  event: Event
):
  | { stepName: string; inline: boolean; creatorMessageId?: string }
  | undefined {
  if (event.eventType === 'step_created') {
    return {
      stepName: event.eventData.stepName,
      inline: event.eventData.inline === true,
      creatorMessageId: event.eventData.creatorMessageId,
    };
  }
  // An inline step's creator is never read (only a background step is
  // re-enqueued by its creator), so its creating start does not record one.
  if (
    event.eventType === 'step_started' &&
    event.eventData?.inline === true &&
    event.eventData.stepName !== undefined
  ) {
    return {
      stepName: event.eventData.stepName,
      inline: true,
    };
  }
  return undefined;
}

export function analyzeLogSteps(events: readonly Event[]): LogStepState[] {
  const steps = new Map<string, LogStepState>();
  const retried = new Set<string>();
  for (const event of events) {
    const cid = event.correlationId;
    if (!cid) continue;
    if (!steps.has(cid)) {
      const creation = stepCreationOf(event);
      if (creation) {
        steps.set(cid, {
          correlationId: cid,
          stepName: creation.stepName,
          createdEventId: event.eventId,
          ...(event.eventType === 'step_created'
            ? { createdAt: new Date(event.createdAt) }
            : {}),
          inline: creation.inline,
          starts: 0,
          terminal: false,
          lastIsRetrying: false,
          runnableInline: false,
        });
      }
    }
    if (event.eventType === 'step_created') continue;
    const step = steps.get(cid);
    if (!step || step.terminal) continue;
    switch (event.eventType) {
      case 'step_started':
        step.starts++;
        step.firstStartedAt ??= new Date(event.createdAt);
        step.lastStartedAt = new Date(event.createdAt);
        step.lastIsRetrying = false;
        break;
      case 'step_retrying':
        step.lastIsRetrying = true;
        retried.add(cid);
        break;
      case 'step_completed':
      case 'step_failed':
        step.terminal = true;
        break;
      default:
        break;
    }
  }
  const out = [...steps.values()];
  for (const step of out) {
    step.runnableInline =
      step.inline && !step.terminal && !retried.has(step.correlationId);
  }
  return out;
}

/** What a run waits on outside its orchestrator (see {@link externalWorkOf}). */
export type ExternalWork = 'step' | 'hook';

/**
 * What the run waits on outside its orchestrator, if anything: `'step'` for
 * a step running from its own message that has no outcome yet (a background
 * step, or an inline step that retried: an inline step's retry moves it to
 * its own message, which runs every later attempt), else `'hook'` for an
 * open hook (created, not disposed), else `undefined`. A step outranks a
 * hook: it decides how long a delivery lingers (see
 * `getOrchestratorLingerMsFor`), and a step's outcome is due soon while a
 * hook may never be resumed.
 *
 * Any open hook counts, however rarely it is resumed: a run that keeps a hook
 * open for its whole life (a cancel or approval hook beside a polling loop)
 * makes every pass that finds nothing to run linger for the hook window,
 * even one that just armed a timer much longer than it.
 *
 * The exception is the parent's child-run completion hook, which stays open
 * for the rest of the run once the parent awaited a child
 * (`child-run-completion.ts`). It is external work only while a child is
 * awaited, which is when the dispatcher waits on its next payload. Given the
 * suspension's `observedHookIds`, an open completion hook not among them does
 * not count. Without them (QuickJS) every open hook counts.
 */
export function externalWorkOf(
  events: readonly Event[],
  observedHookIds?: ReadonlySet<string>
): ExternalWork | undefined {
  const openHooks = new Set<string>();
  const retried = new Set<string>();
  for (const event of events) {
    if (!event.correlationId) continue;
    if (event.eventType === 'hook_created') {
      const token = (event as { eventData?: { token?: unknown } }).eventData
        ?.token;
      const idleCompletionHook =
        observedHookIds !== undefined &&
        typeof token === 'string' &&
        token.startsWith(CHILD_RUN_COMPLETION_TOKEN_PREFIX) &&
        !observedHookIds.has(event.correlationId);
      if (!idleCompletionHook) openHooks.add(event.correlationId);
    } else if (event.eventType === 'hook_disposed') {
      openHooks.delete(event.correlationId);
    } else if (event.eventType === 'step_retrying') {
      retried.add(event.correlationId);
    }
  }
  if (
    analyzeLogSteps(events).some(
      (step) =>
        !step.terminal && (!step.inline || retried.has(step.correlationId))
    )
  ) {
    return 'step';
  }
  return openHooks.size > 0 ? 'hook' : undefined;
}

/**
 * Whether the run waits on work that happens outside its orchestrator: an
 * open hook, or a step running from its own message (see
 * {@link externalWorkOf}).
 */
export function awaitsExternalWork(
  events: readonly Event[],
  observedHookIds?: ReadonlySet<string>
): boolean {
  return externalWorkOf(events, observedHookIds) !== undefined;
}

/**
 * An open wait: created and not completed.
 *
 * Two kinds share the timer machinery. A `sleep()` is open from its
 * `wait_created` until its `wait_completed`. An `experimental_rateLimit()`
 * call that has to wait is open from its committed `rate_created`, which
 * carries the reserved `acquireAt`, until its `rate_acquired` (or a
 * `rate_failed`, which only a World writes): its `resumeAt` is that
 * `acquireAt`, and the orchestrator that completes it writes `rate_acquired`
 * naming the `rate_created`'s slot instead of `wait_completed`.
 */
export interface OpenWait {
  kind: 'wait' | 'rate';
  correlationId: string;
  resumeAt: Date;
  resumeAtMs: number;
  /** The `wait_created`, or the `rate_created` of a rate call. */
  event: Event;
}

export function openWaits(events: readonly Event[]): OpenWait[] {
  const completed = new Set<string>();
  for (const event of events) {
    if (!event.correlationId) continue;
    if (
      event.eventType === 'wait_completed' ||
      event.eventType === 'rate_acquired' ||
      event.eventType === 'rate_failed'
    ) {
      completed.add(event.correlationId);
    }
  }
  const seen = new Set<string>();
  const out: OpenWait[] = [];
  for (const event of events) {
    if (!event.correlationId) continue;
    let kind: OpenWait['kind'];
    let resumeAt: Date;
    if (event.eventType === 'wait_created') {
      kind = 'wait';
      resumeAt = new Date(event.eventData.resumeAt);
    } else if (
      event.eventType === 'rate_created' &&
      event.eventData.acquireAt !== undefined
    ) {
      kind = 'rate';
      resumeAt = new Date(event.eventData.acquireAt);
    } else {
      continue;
    }
    if (completed.has(event.correlationId)) continue;
    const open: OpenWait = {
      kind,
      correlationId: event.correlationId,
      resumeAt,
      resumeAtMs: resumeAt.getTime(),
      event,
    };
    if (seen.has(event.correlationId)) {
      // A rate call woken past its grace window is reserved again: the World
      // commits a new `rate_created` in place of its `rate_acquired`, and the
      // call waits for the newest one's slot. A repeated `wait_created` keeps
      // the first.
      if (kind === 'rate') {
        const at = out.findIndex(
          (wait) => wait.correlationId === event.correlationId
        );
        out[at] = open;
      }
      continue;
    }
    seen.add(event.correlationId);
    out.push(open);
  }
  return out;
}

/**
 * Open waits whose deadline has passed, and open waits named in `wakeUp`
 * (`run.wakeUp()`), whatever their deadline. A rate call is never woken
 * early: its slot is the World's to keep, and the World refuses a
 * `rate_acquired` before it.
 */
export function dueWaits(
  events: readonly Event[],
  nowMs: number,
  wakeUp?: ReadonlySet<string>
): OpenWait[] {
  return openWaits(events).filter(
    (wait) =>
      wait.resumeAtMs <= nowMs ||
      (wait.kind === 'wait' && wakeUp?.has(wait.correlationId))
  );
}

/** The earliest open wait's deadline, as `ConsumedPosition` fields. */
export function nextTimerAt(events: readonly Event[]): {
  nextTimerAtMs?: number;
} {
  let earliest: number | undefined;
  for (const wait of openWaits(events)) {
    if (earliest === undefined || wait.resumeAtMs < earliest) {
      earliest = wait.resumeAtMs;
    }
  }
  return earliest === undefined ? {} : { nextTimerAtMs: earliest };
}

/**
 * A step message's `stepCreatedAt`, as epoch ms: the creation time of a
 * step whose message starts at attempt 1, which its handler passes on that
 * attempt's `step_started`. Left off a retry's message (a step start latency
 * metric covers only the first attempt) and when the time is not known.
 */
export function stepCreatedAtField(step: {
  stepCreatedAt?: Date;
  stepAttempt?: number;
}): { stepCreatedAt?: number } {
  if (step.stepAttempt !== undefined && step.stepAttempt > 1) return {};
  const ms = step.stepCreatedAt?.getTime();
  return ms !== undefined && Number.isFinite(ms) ? { stepCreatedAt: ms } : {};
}
