import { CorruptedEventLogError } from '@workflow/errors';
import { parseDurationToDate, withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import type { StringValue } from 'ms';
import { EventConsumerResult } from '../events-consumer.js';
import {
  type QueueItem,
  type WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';

/**
 * Validates a `wait_completed` event's recorded `resumeAt` against the
 * authoritative value for this wait, returning an error message string if the
 * log is genuinely corrupted, or `null` otherwise.
 *
 * The authoritative `resumeAt` is the one recorded in the event log and applied
 * to the queue item via `wait_created` (`hasCreatedEvent === true`). A
 * duration-based `sleep(<ms|string>)` otherwise derives `resumeAt` from
 * `Date.now()` (see {@link parseDurationToDate}), which is wall-clock-relative
 * and therefore NOT deterministic across replays: the original run computed
 * `start + duration`, while a replay — whose VM clock has advanced to each
 * event's `createdAt` — recomputes a different absolute timestamp.
 *
 * When this consumer never applied a `wait_created` (`hasCreatedEvent` falsy),
 * the queue item normally still holds that freshly-recomputed value, so
 * comparing it against the recorded `wait_completed.resumeAt` would yield a
 * false mismatch on a perfectly consistent log. The correlationId match
 * already establishes the wait's identity, so the equality check is skipped in
 * that case — BUT only when `resumeAt` is non-deterministic (a duration-based
 * `sleep(<ms|string>)`). For an absolute `sleep(Date)` the queue item's
 * `resumeAt` is recomputed identically on every replay
 * (`resumeAtIsDeterministic`), so it remains a valid authoritative value to
 * validate against even without a `wait_created`.
 *
 * A non-finite / unparseable `resumeAt`, however, is malformed irrespective of
 * any authoritative value — the original run always records a valid
 * `parseDurationToDate(...)` Date, so a consistent log never carries one. That
 * is flagged unconditionally, before the `hasCreatedEvent` gate.
 *
 * Note on when the no-`wait_created` state actually arises: instrumented
 * stress reproductions showed every such case was a `wait_completed` whose
 * correlationId has NO matching `wait_created` anywhere in the log — a
 * divergent-replay artifact of the hook-vs-sleep race fixed in #2171 (a
 * non-deterministic race shifted the deterministic ULID sequence, so a sleep
 * got a correlationId absent from the committed log). With #2171 the race is
 * deterministic and this no longer occurs (0 of 300 stress runs, vs readily
 * reproduced with #2171 reverted). This gate is therefore defensive hardening
 * of the validation path, not a fix for an independently-reachable bug.
 */
function detectResumeAtMismatch(
  correlationId: string,
  event: Extract<Event, { eventType: 'wait_completed' }>,
  queueItem: QueueItem | undefined
): string | null {
  const eventResumeAt = event.eventData?.resumeAt;
  if (eventResumeAt === undefined) {
    return null;
  }

  const eventResumeAtDate = new Date(eventResumeAt);
  const eventResumeAtMs = eventResumeAtDate.getTime();

  // An Invalid/non-finite resumeAt is corrupt data regardless of whether an
  // authoritative recorded value exists, so do not gate this on
  // `hasCreatedEvent` — a consistent log never produces one.
  if (!Number.isFinite(eventResumeAtMs)) {
    return (
      `Corrupted event log: wait_completed event for ${correlationId} has ` +
      `invalid resumeAt "${String(eventResumeAt)}"`
    );
  }

  if (!queueItem || queueItem.type !== 'wait') {
    return null;
  }

  // We can validate a finite resumeAt only when we have an authoritative value
  // for it: either a recorded `wait_created` was applied (`hasCreatedEvent`),
  // or the wait's `resumeAt` is deterministic (an absolute `sleep(Date)`, whose
  // value is recomputed identically every replay). For a non-deterministic
  // duration-based sleep without a `wait_created`, the queue item holds a
  // wall-clock-recomputed value that legitimately differs from the recorded
  // one, so skip the equality check to avoid a false `CorruptedEventLogError`.
  const hasAuthoritativeResumeAt =
    queueItem.hasCreatedEvent || queueItem.resumeAtIsDeterministic;
  if (!hasAuthoritativeResumeAt) {
    return null;
  }

  const expectedResumeAt = queueItem.resumeAt;
  if (eventResumeAtMs === expectedResumeAt.getTime()) {
    return null;
  }

  return (
    `Corrupted event log: wait_completed event for ${correlationId} has ` +
    `resumeAt "${eventResumeAtDate.toISOString()}", but the current wait ` +
    `consumer expects "${expectedResumeAt.toISOString()}"`
  );
}

export function createSleep(ctx: WorkflowOrchestratorContext) {
  return async function sleepImpl(
    param: StringValue | Date | number
  ): Promise<void> {
    const { promise, resolve } = withResolvers<void>();
    const correlationId = `wait_${ctx.generateUlid()}`;

    // Calculate the resume time
    const resumeAt = parseDurationToDate(param);

    // A `Date` (or date-like) param yields a deterministic absolute resumeAt —
    // recomputed identically on every replay. A duration (`number`/string)
    // yields `Date.now() + duration`, which varies by replay (the VM clock
    // advances to each event's createdAt). Only the deterministic case can be
    // validated against the event log without a recorded `wait_created`.
    const resumeAtIsDeterministic =
      param instanceof Date ||
      (typeof param === 'object' &&
        param !== null &&
        typeof (param as { getTime?: unknown }).getTime === 'function');

    // Add wait to invocations queue (using Map for O(1) operations)
    const waitItem: WaitInvocationQueueItem = {
      type: 'wait',
      correlationId,
      resumeAt,
      resumeAtIsDeterministic,
    };
    ctx.invocationsQueue.set(correlationId, waitItem);

    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and we're waiting for wait_completed,
      // suspend the workflow until the wait fires
      if (!event) {
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        // We're not interested in this event - the correlationId belongs to a different entity
        return EventConsumerResult.NotConsumed;
      }

      // Check for wait_created event to mark this wait as having the event created
      if (event.eventType === 'wait_created') {
        // Mark this wait as having the created event, but keep it in the queue
        // O(1) lookup using Map
        const queueItem = ctx.invocationsQueue.get(correlationId);
        if (queueItem && queueItem.type === 'wait') {
          queueItem.hasCreatedEvent = true;
          queueItem.resumeAt = event.eventData.resumeAt;
        }
        return EventConsumerResult.Consumed;
      }

      // Check for wait_completed event
      if (event.eventType === 'wait_completed') {
        const queueItem = ctx.invocationsQueue.get(correlationId);
        const mismatch = detectResumeAtMismatch(
          correlationId,
          event,
          queueItem
        );
        if (mismatch) {
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            ctx.onWorkflowError(new CorruptedEventLogError(mismatch));
          });
          return EventConsumerResult.Finished;
        }

        // Remove this wait from the invocations queue (O(1) delete using Map)
        ctx.invocationsQueue.delete(correlationId);

        // This `wait_completed` is a branch-deciding resolution the workflow
        // may `Promise.race` against a hook payload. Order it deterministically
        // by event-log position (see `pendingDeliveryBarriers`):
        //  - Register a 'wait' barrier at this event's index so a LATER-in-log
        //    hook payload is delivered only after this wait.
        //  - Before resolving, defer behind every EARLIER-in-log HOOK delivery
        //    so this wait does not preempt a hook the committed log ordered
        //    first. Then mark this wait delivered to release later hooks.
        const eventIndex = ctx.eventsConsumer.eventIndex;
        const barrier = registerDeliveryBarrier(ctx, eventIndex, 'wait');
        // Defer + resolve in a DETACHED promise (not chained onto the serial
        // `promiseQueue`). `awaitEarlierDeliveries` may wait on an earlier
        // hook delivery whose own resolution is itself driven by the
        // promiseQueue; blocking a queue slot on it would deadlock the serial
        // queue. We still anchor to the queue tail first so prior queued
        // hydration/ordering work runs in event-log order.
        const queueAtCompletion = ctx.promiseQueue;
        void queueAtCompletion
          .then(() => awaitEarlierDeliveries(ctx, eventIndex, ['hook']))
          .then(() => {
            barrier.markDelivered();
            resolve();
          });
        return EventConsumerResult.Finished;
      }

      // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new CorruptedEventLogError(
            `Unexpected event type for wait ${correlationId} "${event.eventType}"`
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
