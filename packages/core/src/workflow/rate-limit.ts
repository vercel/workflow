import { RateLimitMaxWaitError, ReplayDivergenceError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { EventConsumerResult } from '../events-consumer.js';
import type { RateInvocationQueueItem } from '../global.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWorkflowSuspension,
  type WorkflowOrchestratorContext,
} from '../private.js';
import type { RateLimitOptions } from '../rate-limit.js';
import {
  rateLimitSpecVersionMessage,
  resolveRateLimitCall,
} from './rate-limit-call.js';

/**
 * `experimental_rateLimit()` in the workflow VM. One call is one correlation
 * id, `rate_<ulid>`, and settles on the event the World committed for it:
 *
 * - `rate_acquired`: the call goes ahead. The World committed it in place of
 *   the `rate_created` (the slot was now), or the orchestrator wrote it once
 *   the reserved slot had passed.
 * - `rate_created` with `acquireAt`: the slot is later. The call stays
 *   pending, and the run sleeps until then like a `sleep()`.
 * - `rate_failed`: the slot is past the call's `maxWait`. The call rejects with
 *   `RateLimitMaxWaitError`, having reserved nothing.
 */
export function createRateLimit(
  ctx: WorkflowOrchestratorContext,
  runSpecVersion: number | undefined
) {
  return async function rateLimitImpl(
    options: RateLimitOptions
  ): Promise<void> {
    // Only the single orchestrator drives rate limit calls. A run never
    // crosses that version once created, so every replay of the run gives
    // the same answer here. Whether the run is at spec 10 is the World's to
    // say when the call's `rate_created` is written: a backend may raise a
    // spec 9 run to 10 when its `run_started` is written, which a first
    // delivery running ahead of that response cannot know yet, and the
    // World refuses a rate event on a run stamped below 10.
    if ((runSpecVersion ?? 0) < SPEC_VERSION_SINGLE_ORCHESTRATOR) {
      throw new Error(rateLimitSpecVersionMessage(runSpecVersion));
    }
    // The workflow's deterministic clock, so every replay asks for the same
    // deadline.
    const call = resolveRateLimitCall(options, ctx.globalThis.Date.now());

    const { promise, resolve, reject } = withResolvers<void>();
    const correlationId = `rate_${ctx.generateUlid()}`;
    const item: RateInvocationQueueItem = {
      type: 'rate',
      correlationId,
      ...call,
    };
    ctx.invocationsQueue.set(correlationId, item);

    const diverged = (event: { eventId: string }, message: string) => {
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(`Replay divergence: ${message}`, {
            eventId: event.eventId,
          })
        );
      });
      return EventConsumerResult.Finished;
    };

    ctx.eventsConsumer.subscribe((event) => {
      // Nothing more in the log: the call is waiting for its slot, or has
      // not been written yet.
      if (!event) {
        scheduleWorkflowSuspension(ctx);
        return EventConsumerResult.NotConsumed;
      }
      if (event.correlationId !== correlationId) {
        return EventConsumerResult.NotConsumed;
      }

      if (
        (event.eventType === 'rate_created' ||
          event.eventType === 'rate_acquired' ||
          event.eventType === 'rate_failed') &&
        event.eventData?.key !== undefined &&
        event.eventData.key !== call.key
      ) {
        return diverged(
          event,
          `${event.eventType} for ${correlationId} is for rate limit key ${JSON.stringify(event.eventData.key)}, but the current call is for ${JSON.stringify(call.key)}`
        );
      }

      // The slot is later: wait for the `rate_acquired`.
      if (event.eventType === 'rate_created') {
        item.hasCreatedEvent = true;
        return EventConsumerResult.Consumed;
      }

      if (
        event.eventType !== 'rate_acquired' &&
        event.eventType !== 'rate_failed'
      ) {
        return diverged(
          event,
          `Unexpected event type for rate limit call ${correlationId} "${event.eventType}"`
        );
      }

      ctx.invocationsQueue.delete(correlationId);
      const settle =
        event.eventType === 'rate_acquired'
          ? () => resolve()
          : () =>
              reject(
                new RateLimitMaxWaitError(
                  call.key,
                  event.eventData.acquireAt !== undefined
                    ? new Date(event.eventData.acquireAt)
                    : undefined
                )
              );

      // Resolving the call resumes a branch that may draw the next id, as a
      // step result does, so it is ordered by log position against every
      // other branch-deciding delivery (see `sleep.ts` for the shape).
      const eventIndex = ctx.eventsConsumer.eventIndex;
      const barrier = registerDeliveryBarrier(ctx, eventIndex, 'step', {
        deliveredAt: +event.createdAt,
      });
      const earlierDelivered = awaitEarlierDeliveries(ctx, eventIndex, 'step');
      const queueAtResolution = ctx.promiseQueue;
      void queueAtResolution
        .then(() => earlierDelivered)
        .then(() => {
          barrier.markDelivered();
          settle();
        });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
