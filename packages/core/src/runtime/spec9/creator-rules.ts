import {
  type Event,
  QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS,
} from '@workflow/world';
import { stepCreationOf } from './log-state.js';

/**
 * How far inside the queue's dedupe window for a step key
 * ({@link STEP_RESEND_MAX_AGE_MS}) the re-send rule stops: room for the
 * clocks of the sender and the queue to differ, and for a re-send that
 * starts just inside the bound to reach the queue.
 */
export const STEP_RESEND_DEDUPE_MARGIN_MS = 60 * 60 * 1000;

/**
 * How old a step's last send may be for an orchestrator delivery to send its
 * message again: {@link STEP_RESEND_DEDUPE_MARGIN_MS} inside the shortest
 * time every World deduplicates a step's stable idempotency key
 * (`QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS` in `@workflow/world`;
 * `stepDispatchIdempotencyKey`). A send this young is deduped against the
 * step's first message while that message lives, so a re-send never creates
 * a second live message, which would be a second owner of the step's body.
 * Nothing on the write path refuses a second `step_started` of a step that
 * is still running, so this bound is what keeps a re-send from duplicating
 * one. A re-send that reaches the queue after the step's message ended is
 * marked (`stepResent`), and its first delivery reads the log and finds the
 * step's outcome.
 */
export const STEP_RESEND_MAX_AGE_MS =
  QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS - STEP_RESEND_DEDUPE_MARGIN_MS;

/** What {@link stepsToReenqueue} decided for one orchestrator delivery. */
export interface StepResends {
  /** Steps whose message to send again, in log order. */
  resend: string[];
  /** Steps it would re-send but whose last send is past the age bound. */
  tooOld: string[];
}

/**
 * Background steps this orchestrator delivery must enqueue again.
 *
 * A background step's message is enqueued once, right after its
 * `step_created` commits. A delivery that dies between the commit and the
 * enqueue leaves the step with no message, and nothing in the log says so.
 * So every orchestrator delivery that is not the first delivery of its
 * message (`deliveryCount` above 1: a redelivery after a crash, a lapsed
 * lease or a rejection, a handoff continuation, a coalesced re-run, or a
 * World that reports no count) re-sends every background step that has a
 * `step_created` and no `step_started`, whichever delivery created it, once
 * per invocation (see {@link invocationResends}). The queue guarantees such
 * a delivery happens after any delivery that died: the dead delivery's
 * message is redelivered, or coalesced into a running delivery, whose re-run
 * reports the next count. A re-send keeps the step's stable idempotency key,
 * so one whose first message still lives is deduped; a step created more
 * than {@link STEP_RESEND_MAX_AGE_MS} ago is left alone (`tooOld`), because
 * past the dedupe window a second message would be a second owner of its
 * body.
 *
 * Inline steps are never enqueued here, with one exception: an inline step
 * whose last event is the `step_retrying` that moved it to the background.
 * The orchestrator delivery that ran the failed attempt writes it and stamps
 * it with its own message (`creatorMessageId`, see
 * {@link withRetryCreator}). A delivery that dies between that write and the
 * enqueue of the step's retry message leaves the step with no message, and
 * the orchestrator never runs it inline again (its retry belongs to its own
 * message), so the same rule as a background step's creation closes the
 * window: any orchestrator delivery that is not its message's first re-sends
 * it, whichever delivery wrote the `step_retrying`, within the same age bound
 * counted from that write. A `step_retrying` the step's own message wrote (a
 * later attempt) carries no creator: that message stays unacknowledged until
 * the step ends, so no orchestrator re-sends it. Nor does one from a log
 * written before the stamp existed.
 *
 * `recovery` is a delivery of a message a World sent after it lost its
 * queue (`reenqueueActiveRuns` with `queueLost`, world-local after a
 * restart): every step message died with the queue, along with its dedupe
 * state, so the delivery also re-sends steps that started and have no
 * outcome, inline steps whose retry moved to the background included, and
 * applies no age bound.
 */
export function stepsToReenqueue(params: {
  events: readonly Event[];
  deliveryCount: number | undefined;
  nowMs: number;
  recovery?: boolean;
  /** Steps this invocation already re-sent, or found too old. */
  exclude?: { has(correlationId: string): boolean };
}): StepResends {
  const { events, deliveryCount, nowMs, exclude } = params;
  const recovery = params.recovery === true;
  const out: StepResends = { resend: [], tooOld: [] };
  if (!recovery && deliveryCount === 1) return out;
  const steps = new Map<
    string,
    {
      inline: boolean;
      createdAtMs: number;
      started: boolean;
      terminal: boolean;
      retried: boolean;
      lastIsRetrying: boolean;
      /** The `creatorMessageId` of the last event, if a `step_retrying`. */
      retryCreator?: string;
      retriedAtMs?: number;
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
          createdAtMs: eventTimeMs(event),
          started: false,
          terminal: false,
          retried: false,
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
          step.retried = true;
          step.lastIsRetrying = true;
          step.retryCreator = retryCreatorMessageId(event);
          step.retriedAtMs = eventTimeMs(event);
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
  for (const [cid, step] of steps) {
    if (step.terminal || exclude?.has(cid)) continue;
    if (recovery) {
      // Every step that runs from its own message: a background step, or an
      // inline step whose retry moved there.
      if (!step.inline || step.retried) out.resend.push(cid);
      continue;
    }
    let sentAtMs: number | undefined;
    if (!step.inline) {
      if (!step.started) sentAtMs = step.createdAtMs;
    } else if (step.lastIsRetrying && step.retryCreator !== undefined) {
      sentAtMs = step.retriedAtMs;
    }
    if (sentAtMs === undefined) continue;
    if (!(nowMs - sentAtMs < STEP_RESEND_MAX_AGE_MS)) {
      out.tooOld.push(cid);
      continue;
    }
    out.resend.push(cid);
  }
  return out;
}

/**
 * Whether an orchestrator delivery passes the re-send gate of
 * {@link stepsToReenqueue}: it is not the first delivery of its message, or
 * the World cannot say, or it is a recovery delivery.
 */
export function passesResendGate(params: {
  deliveryCount: number | undefined;
  recovery?: boolean;
}): boolean {
  return params.recovery === true || params.deliveryCount !== 1;
}

/**
 * What one invocation re-sent (see {@link stepsToReenqueue}), so its later
 * passes and coalesced re-runs do not send it again.
 */
export interface InvocationResends {
  /** Steps whose message this invocation re-sent. */
  readonly sent: Set<string>;
  /** Steps it left alone because their last send is past the age bound. */
  readonly tooOld: Set<string>;
  /** Whether a delivery of this invocation already ran the re-send pass. */
  swept: boolean;
}

// per-copy-ok: a coalesced re-run is a new handler call of the same function
// invocation, in the same module copy that handled its first delivery. State
// split across copies only costs a deduped re-send.
const invocations = new Map<string, InvocationResends>();
const MAX_TRACKED_INVOCATIONS = 1_000;

/**
 * The re-send state of the invocation a delivery runs in. Coalesced re-runs
 * of a delivery share the function invocation that ran it, which a World
 * reports as `invocationStartedAt` (see `Queue.createQueueHandler`): they
 * share this state, keyed by run, message and invocation start. Without
 * `invocationStartedAt` every delivery is an invocation of its own. Bounded:
 * the oldest invocation is forgotten past {@link MAX_TRACKED_INVOCATIONS}.
 */
export function invocationResends(params: {
  runId: string;
  messageId: string;
  invocationStartedAt: number | undefined;
}): InvocationResends {
  const fresh = (): InvocationResends => ({
    sent: new Set(),
    tooOld: new Set(),
    swept: false,
  });
  if (params.invocationStartedAt === undefined) return fresh();
  const key = `${params.runId}|${params.messageId}|${params.invocationStartedAt}`;
  let state = invocations.get(key);
  if (!state) {
    state = fresh();
    invocations.set(key, state);
    if (invocations.size > MAX_TRACKED_INVOCATIONS) {
      const oldest = invocations.keys().next().value;
      if (oldest !== undefined) invocations.delete(oldest);
    }
  }
  return state;
}

function eventTimeMs(event: Event): number {
  const ms = +new Date(event.createdAt);
  // An event with no usable time is treated as too old to re-send.
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * `data` with this orchestrator delivery's message (`messageId`) stamped as
 * the creator when it is a `step_retrying`: the write that moves an inline
 * step's retry to the background, which any later orchestrator delivery that
 * is not its message's first may re-send (see {@link stepsToReenqueue}). Any
 * other event is returned as is.
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
 * completed the wait, and the queue may coalesce that redelivery into a
 * delivery that owns no chain. Sent first, the timer is either out before
 * the completion commits, or the send failed, nothing committed, and the
 * redelivery finds the wait still open and due and decides again. A
 * duplicate timer is deduplicated by its hop's key, or finds its wait open
 * and re-arms what is left, or completed and arms nothing.
 *
 * A timer delivery completing its own wait counts like any other: the
 * redelivery of a timer owns its chain (`ownedWaitChains`), but a
 * redelivery the queue coalesces into another delivery is never made. A
 * wait with no recorded creator is left out: no delivery owns its chain.
 */
export function chainTimersBeforeCompletion<
  W extends { correlationId: string; resumeAtMs: number; event?: Event },
>(params: { openWaits: readonly W[]; completing: Iterable<string> }): W[] {
  const { openWaits } = params;
  const completing = new Set(params.completing);
  const next = new Map<string, W>();
  for (const correlationId of completing) {
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
