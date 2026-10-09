import type { Event } from '@workflow/world';

/**
 * Background steps this orchestrator delivery must enqueue again.
 *
 * A background step's message is enqueued once, right after its
 * `step_created` commits. The only invocation that may enqueue it again is a
 * REDELIVERY of the message whose invocation wrote that `step_created`
 * (`creatorMessageId`), and only while the step has no `step_started`: that
 * is the crash window between the commit and the enqueue, and it closes
 * within minutes, well inside the queue's dedupe window for the step's stable
 * key. Any broader rule ("re-enqueue every open background step on replay")
 * would eventually send a second message for a step whose first message is
 * still retrying past the dedupe window, which is a second owner of its body.
 *
 * Inline steps are never enqueued here, with one exception: an inline step
 * whose last event is a `step_retrying` has moved to the background, and the
 * crash window between that write and the enqueue of its retry message is
 * closed the same way, by a redelivery.
 */
export function stepsToReenqueue(params: {
  events: readonly Event[];
  messageId: string;
  deliveryCount: number | undefined;
}): string[] {
  const { events, messageId, deliveryCount } = params;
  if (deliveryCount === 1) return [];
  const steps = new Map<
    string,
    {
      inline: boolean;
      creator?: string;
      started: boolean;
      terminal: boolean;
      lastIsRetrying: boolean;
    }
  >();
  for (const event of events) {
    const cid = event.correlationId;
    if (!cid) continue;
    switch (event.eventType) {
      case 'step_created':
        if (!steps.has(cid)) {
          steps.set(cid, {
            inline: event.eventData.inline === true,
            creator: event.eventData.creatorMessageId,
            started: false,
            terminal: false,
            lastIsRetrying: false,
          });
        }
        break;
      case 'step_started': {
        const step = steps.get(cid);
        if (step) {
          step.started = true;
          step.lastIsRetrying = false;
        }
        break;
      }
      case 'step_retrying': {
        const step = steps.get(cid);
        if (step) step.lastIsRetrying = true;
        break;
      }
      case 'step_completed':
      case 'step_failed': {
        const step = steps.get(cid);
        if (step) step.terminal = true;
        break;
      }
      default:
        break;
    }
  }
  const out: string[] = [];
  for (const [cid, step] of steps) {
    if (step.terminal) continue;
    if (!step.inline) {
      if (!step.started && step.creator === messageId) out.push(cid);
    } else if (step.lastIsRetrying) {
      out.push(cid);
    }
  }
  return out;
}

/**
 * Whether this orchestrator delivery schedules the timer of the wait
 * `correlationId`.
 *
 * Only the invocation that wrote the wait's `wait_created` schedules its
 * timer, or a redelivery of that same message, or the timer delivery for the
 * wait itself (whose delay a queue may have capped short of the deadline, so
 * it re-arms what is left). Every other delivery leaves the timer alone, so
 * timer messages do not pile up across suspensions. A late or duplicate
 * timer finds the wait completed and exits cheaply.
 */
export function schedulesWaitTimer(params: {
  wait: Event | undefined;
  correlationId: string;
  messageId: string;
  timerFor: string | undefined;
}): boolean {
  const { wait, correlationId, messageId, timerFor } = params;
  if (timerFor === correlationId) return true;
  if (wait === undefined) {
    // Not in the log yet: this delivery is about to write it.
    return true;
  }
  return (
    wait.eventType === 'wait_created' &&
    wait.eventData.creatorMessageId === messageId
  );
}
