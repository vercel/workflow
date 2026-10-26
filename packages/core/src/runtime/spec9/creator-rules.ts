import type { Event } from '@workflow/world';
import { stepCreationOf } from './log-state.js';

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
 * whose last event is the `step_retrying` that moved it to the background.
 * The orchestrator delivery that ran the failed attempt writes it and stamps
 * it with its own message (`creatorMessageId`, see
 * {@link withRetryCreator}); the crash window between that write and the
 * enqueue of the step's retry message is closed the same way, by a
 * redelivery of that message. A `step_retrying` the step's own message
 * wrote (a later attempt) carries no creator: that message stays
 * unacknowledged until the step ends, so no orchestrator re-sends it. Nor
 * does one from a log written before the stamp existed.
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
      /** The `creatorMessageId` of the last event, if a `step_retrying`. */
      retryCreator?: string;
    }
  >();
  for (const event of events) {
    const cid = event.correlationId;
    if (!cid) continue;
    if (!steps.has(cid)) {
      // An inline step's creation may be its first `step_started`.
      const creation = stepCreationOf(event);
      if (creation) {
        steps.set(cid, {
          inline: creation.inline,
          creator: creation.creatorMessageId,
          started: false,
          terminal: false,
          lastIsRetrying: false,
        });
      }
    }
    switch (event.eventType) {
      case 'step_started': {
        const step = steps.get(cid);
        if (step) {
          step.started = true;
          step.lastIsRetrying = false;
          step.retryCreator = undefined;
        }
        break;
      }
      case 'step_retrying': {
        const step = steps.get(cid);
        if (step) {
          step.lastIsRetrying = true;
          step.retryCreator = retryCreatorMessageId(event);
        }
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
    } else if (step.lastIsRetrying && step.retryCreator === messageId) {
      out.push(cid);
    }
  }
  return out;
}

/**
 * `data` with this orchestrator delivery's message (`messageId`) stamped as
 * the creator when it is a `step_retrying`: the write that moves an inline
 * step's retry to the background, which only a redelivery of `messageId`
 * may re-send (see {@link stepsToReenqueue}). Any other event is returned
 * as is.
 */
export function withRetryCreator<
  T extends { eventType: string; eventData?: unknown },
>(data: T, messageId: string | undefined): T {
  if (data.eventType !== 'step_retrying' || messageId === undefined) {
    return data;
  }
  return {
    ...data,
    eventData: {
      ...(data.eventData as Record<string, unknown>),
      creatorMessageId: messageId,
    },
  };
}

function retryCreatorMessageId(event: Event): string | undefined {
  const creator = (event.eventData as { creatorMessageId?: unknown })
    ?.creatorMessageId;
  return typeof creator === 'string' ? creator : undefined;
}

/**
 * The wait chains whose timers this orchestrator delivery arms, each named
 * by its creator: the message whose delivery wrote the chain's
 * `wait_created` events (`creatorMessageId`). A delivery that creates
 * several waits arms only the earliest (see {@link waitTimersToArm}), so the
 * rest of its chain waits for whoever completes that one.
 *
 * A delivery owns:
 *
 * - its own message's chain: the waits its message created (on a
 *   redelivery, in an earlier delivery of it), and those it is about to
 *   write;
 * - the chain of every wait whose `wait_completed` it committed
 *   (`completedWaits`), whatever message it is. The delivery that completes
 *   a wait is the only one that knows the chain needs its next timer: the
 *   completing delivery may be a hook or step wake into which the queue
 *   coalesced the wait's timer, and a coalesced timer is never delivered;
 * - on a redelivery of a timer message (`timerFor`, a crash or a rejected
 *   delivery), that timer's chain: an earlier delivery of the message may
 *   have completed the wait and died before it armed the next one.
 *
 * Every other delivery leaves a chain alone, so timer messages do not pile
 * up across suspensions. A late or duplicate timer finds its wait completed
 * and arms nothing.
 */
export function ownedWaitChains(params: {
  events: readonly Event[];
  messageId: string;
  /** Waits whose `wait_completed` this delivery committed. */
  completedWaits: Iterable<string>;
  /** The wait a timer delivery is for. */
  timerFor: string | undefined;
  /** Whether this delivery is a redelivery of its message. */
  redelivery: boolean;
}): Set<string> {
  const { events, messageId, completedWaits, timerFor, redelivery } = params;
  const owned = new Set([messageId]);
  const creatorOf = (correlationId: string) =>
    waitCreatorMessageId(
      events.find(
        (event) =>
          event.eventType === 'wait_created' &&
          event.correlationId === correlationId
      )
    );
  for (const correlationId of completedWaits) {
    const creator = creatorOf(correlationId);
    if (creator !== undefined) owned.add(creator);
  }
  if (redelivery && timerFor !== undefined) {
    const creator = creatorOf(timerFor);
    if (creator !== undefined) owned.add(creator);
  }
  return owned;
}

/**
 * Whether this orchestrator delivery may arm the timer of the open wait
 * `correlationId`: the wait is in a chain it owns
 * ({@link ownedWaitChains}), it is about to write the wait, or it is the
 * wait's own timer delivery, which arrived before the wait was due (a timer
 * is delivered a little early under clock skew) and re-arms what is left.
 */
export function schedulesWaitTimer(params: {
  wait: Event | undefined;
  correlationId: string;
  timerFor: string | undefined;
  ownedChains: ReadonlySet<string>;
}): boolean {
  const { wait, correlationId, timerFor, ownedChains } = params;
  if (timerFor === correlationId) return true;
  if (wait === undefined) {
    // Not in the log yet: this delivery is about to write it.
    return true;
  }
  const creator = waitCreatorMessageId(wait);
  return creator !== undefined && ownedChains.has(creator);
}

/**
 * The timers a delivery sends before it commits the `wait_completed` of each
 * wait in `completing`: for each, the earliest open wait of its chain that
 * is not being completed too. A chain's next timer is otherwise armed only
 * by a delivery that holds the completion in memory (`ownedWaitChains`), so
 * a delivery that commits the completion and fails before the send would
 * leave the chain with no timer: its redelivery no longer knows it
 * completed the wait. Sent first, the timer is either out before the
 * completion commits, or the send failed, nothing committed, and the
 * redelivery finds the wait still open and due and decides again. A
 * duplicate timer finds its wait open and re-arms what is left, or
 * completed and arms nothing.
 *
 * The wait a timer delivery is for (`timerFor`) is left out: a redelivery
 * of that timer owns its chain anyway. So is a wait with no recorded
 * creator, whose chain no delivery owns.
 */
export function chainTimersBeforeCompletion<
  W extends { correlationId: string; resumeAtMs: number; event?: Event },
>(params: {
  openWaits: readonly W[];
  completing: Iterable<string>;
  timerFor: string | undefined;
}): W[] {
  const { openWaits, timerFor } = params;
  const completing = new Set(params.completing);
  const next = new Map<string, W>();
  for (const correlationId of completing) {
    if (correlationId === timerFor) continue;
    const creator = waitCreatorMessageId(
      openWaits.find((wait) => wait.correlationId === correlationId)?.event
    );
    if (creator === undefined || next.has(creator)) continue;
    let earliest: W | undefined;
    for (const wait of openWaits) {
      if (completing.has(wait.correlationId)) continue;
      if (waitCreatorMessageId(wait.event) !== creator) continue;
      if (!earliest || wait.resumeAtMs < earliest.resumeAtMs) earliest = wait;
    }
    if (earliest) next.set(creator, earliest);
  }
  return [...next.values()];
}

/**
 * The waits whose timers to arm, out of the open waits a delivery may arm
 * ({@link schedulesWaitTimer}): the earliest of each chain, and the wait a
 * timer delivery is for (`timerFor`). A wait not in the log yet is in the
 * chain of `messageId`.
 *
 * A delivery that completes a wait of a chain sends the chain's next timer
 * before the completion commits ({@link chainTimersBeforeCompletion}), so a
 * failure after the commit leaves the chain armed.
 */
export function waitTimersToArm<
  W extends { correlationId: string; resumeAtMs: number; event?: Event },
>(waits: readonly W[], messageId: string, timerFor: string | undefined): W[] {
  const earliest = new Map<string, W>();
  const out: W[] = [];
  for (const wait of waits) {
    if (wait.correlationId === timerFor) out.push(wait);
    const chain = waitCreatorMessageId(wait.event) ?? messageId;
    const current = earliest.get(chain);
    if (!current || wait.resumeAtMs < current.resumeAtMs) {
      earliest.set(chain, wait);
    }
  }
  for (const wait of earliest.values()) {
    if (!out.includes(wait)) out.push(wait);
  }
  return out;
}

/** The message whose invocation wrote `wait`'s `wait_created`, if recorded. */
export function waitCreatorMessageId(
  wait: Event | undefined
): string | undefined {
  return wait?.eventType === 'wait_created'
    ? wait.eventData.creatorMessageId
    : undefined;
}
