import {
  type Event,
  isTerminalRunEventType,
  type StepStartReason,
} from '@workflow/world';

/**
 * What a background step's queue handler does with one delivery of the step's
 * message. The handler never replays the workflow; this is the whole decision
 * it makes before it runs a body.
 */
export type StepDeliveryDecision =
  /** Acknowledge the message without running the body. */
  | { action: 'ack'; reason: 'step-terminal' | 'run-terminal' }
  /** Redeliver the same message after `timeoutSeconds`. */
  | { action: 'redeliver'; timeoutSeconds: number; reason: 'retry-after' }
  /** Write `step_failed` for exceeding the retry budget, then acknowledge. */
  | { action: 'fail'; attempt: number; reason: 'max-retries' }
  /** Write `step_started` with this attempt and reason, then run the body. */
  | { action: 'run'; attempt: number; startReason: StepStartReason };

/**
 * Whether a delivery must read the run's full log before deciding.
 *
 * Only the first delivery of a message that does not mark a retry may skip
 * the read. Any other delivery may follow a committed outcome whose response
 * was lost, an invocation that died mid-body, or an early redelivery, and only
 * the log can tell those apart. A queue that cannot report a delivery count
 * gives `undefined`, which is treated as "possibly a redelivery".
 */
export function stepDeliveryNeedsLogRead(params: {
  deliveryCount: number | undefined;
  stepAttempt: number | undefined;
}): boolean {
  return params.deliveryCount !== 1 || (params.stepAttempt ?? 1) > 1;
}

/**
 * The decision for a delivery that may skip the log read
 * ({@link stepDeliveryNeedsLogRead} returned false): the message's own attempt.
 */
export function firstDeliveryDecision(
  stepAttempt: number | undefined
): StepDeliveryDecision {
  const attempt = stepAttempt ?? 1;
  return {
    action: 'run',
    attempt,
    startReason: attempt > 1 ? 'retry' : 'first',
  };
}

/**
 * The decision for a delivery that read the run's full log. The rows of the
 * table, in order:
 *
 * | Log shows | Decision |
 * |---|---|
 * | a terminal event for the step | ack, no body |
 * | a terminal run event | ack, no body |
 * | the latest `step_retrying`'s `retryAfter` not reached | redeliver after the rest |
 * | attempt above `maxRetries + 1` | `step_failed`, ack |
 * | otherwise | `step_started` with attempt = starts + 1, run the body |
 *
 * Attempt is the number of `step_started` events for the step plus one. With
 * one owner per step that count is exact, so a `maxRetries: 0` step that
 * already started once is failed instead of run again (at most once).
 *
 * `startReason` is `first` with no prior start, `retry` when the latest
 * event of the step is a `step_retrying`, and `redelivery` when a prior
 * attempt started and recorded nothing after it (its invocation died or
 * stalled past its lease).
 */
export function decideStepDelivery(params: {
  events: readonly Event[];
  stepId: string;
  maxRetries: number;
  nowMs: number;
}): StepDeliveryDecision {
  const { events, stepId, maxRetries, nowMs } = params;
  let starts = 0;
  let lastStepEvent: Event | undefined;
  let lastRetrying: Event | undefined;
  for (const event of events) {
    if (isTerminalRunEventType(event.eventType)) {
      return { action: 'ack', reason: 'run-terminal' };
    }
    if (event.correlationId !== stepId) continue;
    switch (event.eventType) {
      case 'step_completed':
      case 'step_failed':
        return { action: 'ack', reason: 'step-terminal' };
      case 'step_started':
        starts++;
        lastStepEvent = event;
        break;
      case 'step_retrying':
        lastRetrying = event;
        lastStepEvent = event;
        break;
      default:
        break;
    }
  }

  if (lastStepEvent !== undefined && lastStepEvent === lastRetrying) {
    const retryAfter =
      lastRetrying.eventType === 'step_retrying'
        ? lastRetrying.eventData.retryAfter
        : undefined;
    const retryAtMs = retryAfter ? new Date(retryAfter).getTime() : undefined;
    if (retryAtMs !== undefined && retryAtMs > nowMs) {
      return {
        action: 'redeliver',
        timeoutSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000)),
        reason: 'retry-after',
      };
    }
  }

  const attempt = starts + 1;
  if (attempt > maxRetries + 1) {
    return { action: 'fail', attempt, reason: 'max-retries' };
  }
  const startReason: StepStartReason =
    starts === 0
      ? 'first'
      : lastStepEvent?.eventType === 'step_retrying'
        ? 'retry'
        : 'redelivery';
  return { action: 'run', attempt, startReason };
}
