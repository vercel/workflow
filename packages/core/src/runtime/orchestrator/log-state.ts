import type { Event, SerializedData, StepStartReason } from '@workflow/world';

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
  input?: SerializedData;
  stepAttempt?: number;
}

/** An inline step to run in this process. */
export interface InlineStepSpec {
  correlationId: string;
  stepName: string;
  input?: SerializedData;
  createdEventId?: string;
  attempt: number;
  startReason: StepStartReason;
  firstStartedAt?: Date;
  /**
   * The step's `step_started`, when the orchestrator wrote it together with
   * `step_created` (one batch). The executor then writes no start.
   */
  started?: { startedAt: Date; postSentAtMs?: number; completedAtMs?: number };
  /** The World's refusal of that batched start. */
  startRefusal?: Error;
  /**
   * Settles once the step's `step_created` committed, when the body starts
   * while that commit is in flight (turbo), with the start when the same
   * batch committed it. Otherwise its `step_started` waits for it.
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
  inline: boolean;
  starts: number;
  /** When the step's first attempt started. */
  firstStartedAt?: Date;
  terminal: boolean;
  /** The step's last event is a `step_retrying`. */
  lastIsRetrying: boolean;
  /**
   * An inline-mode step that is open and has not moved to the background:
   * the current orchestrator runs it (again) in its own process.
   */
  runnableInline: boolean;
}

export function analyzeLogSteps(events: readonly Event[]): LogStepState[] {
  const steps = new Map<string, LogStepState>();
  for (const event of events) {
    const cid = event.correlationId;
    if (!cid) continue;
    if (event.eventType === 'step_created') {
      if (!steps.has(cid)) {
        steps.set(cid, {
          correlationId: cid,
          stepName: event.eventData.stepName,
          createdEventId: event.eventId,
          inline: event.eventData.inline === true,
          starts: 0,
          terminal: false,
          lastIsRetrying: false,
          runnableInline: false,
        });
      }
      continue;
    }
    const step = steps.get(cid);
    if (!step || step.terminal) continue;
    switch (event.eventType) {
      case 'step_started':
        step.starts++;
        step.firstStartedAt ??= new Date(event.createdAt);
        step.lastIsRetrying = false;
        break;
      case 'step_retrying':
        step.lastIsRetrying = true;
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
    step.runnableInline = step.inline && !step.terminal && !step.lastIsRetrying;
  }
  return out;
}

/** An open wait: created and not completed. */
export interface OpenWait {
  correlationId: string;
  resumeAt: Date;
  resumeAtMs: number;
  event: Event;
}

export function openWaits(events: readonly Event[]): OpenWait[] {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'wait_completed' && event.correlationId) {
      completed.add(event.correlationId);
    }
  }
  const seen = new Set<string>();
  const out: OpenWait[] = [];
  for (const event of events) {
    if (event.eventType !== 'wait_created' || !event.correlationId) continue;
    if (completed.has(event.correlationId) || seen.has(event.correlationId)) {
      continue;
    }
    seen.add(event.correlationId);
    const resumeAt = new Date(event.eventData.resumeAt);
    out.push({
      correlationId: event.correlationId,
      resumeAt,
      resumeAtMs: resumeAt.getTime(),
      event,
    });
  }
  return out;
}

/**
 * Open waits whose deadline has passed, and open waits named in `wakeUp`
 * (`run.wakeUp()`), whatever their deadline.
 */
export function dueWaits(
  events: readonly Event[],
  nowMs: number,
  wakeUp?: ReadonlySet<string>
): OpenWait[] {
  return openWaits(events).filter(
    (wait) => wait.resumeAtMs <= nowMs || wakeUp?.has(wait.correlationId)
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
