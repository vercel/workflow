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
 * the queue item still holds that freshly-recomputed value, so comparing it
 * against the recorded `wait_completed.resumeAt` yields a false mismatch on a
 * perfectly consistent log. The correlationId match already establishes the
 * wait's identity, so the resumeAt check is skipped in that case.
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
  if (!queueItem || queueItem.type !== 'wait' || !queueItem.hasCreatedEvent) {
    // No authoritative recorded resumeAt to compare against.
    return null;
  }

  const expectedResumeAt = queueItem.resumeAt;
  const eventResumeAtDate = new Date(eventResumeAt);
  const eventResumeAtMs = eventResumeAtDate.getTime();
  if (eventResumeAtMs === expectedResumeAt.getTime()) {
    return null;
  }

  const eventResumeAtForMessage = Number.isFinite(eventResumeAtMs)
    ? eventResumeAtDate.toISOString()
    : String(eventResumeAt);
  return (
    `Corrupted event log: wait_completed event for ${correlationId} has ` +
    `resumeAt "${eventResumeAtForMessage}", but the current wait consumer ` +
    `expects "${expectedResumeAt.toISOString()}"`
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

    // Add wait to invocations queue (using Map for O(1) operations)
    const waitItem: WaitInvocationQueueItem = {
      type: 'wait',
      correlationId,
      resumeAt,
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
