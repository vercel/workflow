import {
  FatalError,
  LockUnsupportedError,
  ReplayDivergenceError,
} from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { LOCK_KEY_MAX_LENGTH } from '@workflow/world';
import { EventConsumerResult } from '../events-consumer.js';
import type { LockInvocationQueueItem } from '../global.js';
import type { LockOptions, LockSlot } from '../lock.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWorkflowSuspension,
  type WorkflowOrchestratorContext,
} from '../private.js';

function validateLockArguments(
  key: unknown,
  options: unknown
): { key: string; concurrency: number; leaseTtlMs?: number } {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > LOCK_KEY_MAX_LENGTH
  ) {
    throw new FatalError(
      `experimental_lock() key must be a non-empty string of at most ${LOCK_KEY_MAX_LENGTH} characters`
    );
  }
  const opts = (options ?? {}) as Partial<LockOptions>;
  if (
    typeof opts.concurrency !== 'number' ||
    !Number.isInteger(opts.concurrency) ||
    opts.concurrency < 1
  ) {
    throw new FatalError(
      `experimental_lock("${key}") requires an integer \`concurrency\` of at least 1`
    );
  }
  if (
    opts.leaseTtlMs !== undefined &&
    (typeof opts.leaseTtlMs !== 'number' ||
      !Number.isInteger(opts.leaseTtlMs) ||
      opts.leaseTtlMs < 1)
  ) {
    throw new FatalError(
      `experimental_lock("${key}") \`leaseTtlMs\` must be a positive integer of milliseconds`
    );
  }
  return {
    key,
    concurrency: opts.concurrency,
    ...(opts.leaseTtlMs !== undefined && { leaseTtlMs: opts.leaseTtlMs }),
  };
}

export function createLock(ctx: WorkflowOrchestratorContext) {
  return async function lockImpl(
    rawKey: unknown,
    rawOptions: unknown
  ): Promise<LockSlot> {
    const { key, concurrency, leaseTtlMs } = validateLockArguments(
      rawKey,
      rawOptions
    );
    // Fail closed: a World that cannot enforce the limit must never be handed
    // lock events, and the workflow must not proceed as if it held a slot.
    if (ctx.worldCapabilities?.locks?.concurrency !== true) {
      throw new LockUnsupportedError(key);
    }

    const { promise, resolve } = withResolvers<LockSlot>();
    const correlationId = `lock_${ctx.generateUlid()}`;

    const item: LockInvocationQueueItem = {
      type: 'lock',
      correlationId,
      key,
      concurrency,
      ...(leaseTtlMs !== undefined && { leaseTtlMs }),
    };
    ctx.invocationsQueue.set(correlationId, item);

    let acquired = false;
    let releasedByCode = false;
    let hasReleasedEvent = false;

    const diverge = (eventId: string, message: string) => {
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(
            `Replay divergence: ${message} (lock ${correlationId})`,
            { eventId }
          )
        );
      });
      return EventConsumerResult.Finished;
    };

    function release(): void {
      if (releasedByCode) return;
      releasedByCode = true;
      // Replaying past a release the log already records: nothing is owed.
      if (hasReleasedEvent) return;
      const queued = ctx.invocationsQueue.get(correlationId);
      if (queued?.type === 'lock') {
        queued.released = true;
      }
    }

    function makeSlot(fencingToken: number, effectiveConcurrency: number) {
      const slot: LockSlot = {
        key,
        fencingToken,
        concurrency: effectiveConcurrency,
        release,
        [Symbol.dispose]: release,
        [Symbol.asyncDispose]: async () => release(),
      };
      // `using` / `await using` inside the sandbox look the disposers up by
      // the VM's own symbols, which may be polyfills distinct from the host's.
      const vmSymbol = ctx.globalThis.Symbol as SymbolConstructor;
      if (vmSymbol.dispose && vmSymbol.dispose !== Symbol.dispose) {
        (slot as any)[vmSymbol.dispose] = release;
      }
      if (
        vmSymbol.asyncDispose &&
        vmSymbol.asyncDispose !== Symbol.asyncDispose
      ) {
        (slot as any)[vmSymbol.asyncDispose] = async () => release();
      }
      return slot;
    }

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        // End of the log. Waiting for a slot is a suspension; holding one is
        // not, so a held lock leaves the decision to whatever else the
        // workflow is awaiting.
        if (!acquired) {
          scheduleWorkflowSuspension(ctx);
        }
        return EventConsumerResult.NotConsumed;
      }
      if (event.correlationId !== correlationId) {
        return EventConsumerResult.NotConsumed;
      }

      if (
        event.eventType === 'lock_created' ||
        event.eventType === 'lock_acquired'
      ) {
        const recorded = event.eventData;
        if (recorded.key !== key || recorded.concurrency !== concurrency) {
          return diverge(
            event.eventId,
            `${event.eventType} recorded experimental_lock("${recorded.key}", { concurrency: ${recorded.concurrency} }) but the workflow now asks for experimental_lock("${key}", { concurrency: ${concurrency} })`
          );
        }
      }

      if (event.eventType === 'lock_created') {
        const queued = ctx.invocationsQueue.get(correlationId);
        if (queued?.type === 'lock') {
          queued.hasCreatedEvent = true;
        }
        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'lock_acquired') {
        if (acquired) {
          return diverge(event.eventId, 'a second lock_acquired');
        }
        acquired = true;
        const queued = ctx.invocationsQueue.get(correlationId);
        if (queued?.type === 'lock') {
          queued.acquired = true;
        }
        const slot = makeSlot(
          event.eventData.fencingToken,
          event.eventData.effectiveConcurrency
        );
        // A grant is branch-deciding exactly like a `wait_completed`: order
        // its delivery by log position against earlier hook payloads, step
        // results, waits and attribute writes, and gate later ones on it. The
        // deferral is captured while consuming and resolved in a detached
        // chain; see `workflow/sleep.ts` for why each half is where it is.
        const eventIndex = ctx.eventsConsumer.eventIndex;
        const barrier = registerDeliveryBarrier(ctx, eventIndex, 'lock', {
          deliveredAt: +event.createdAt,
        });
        const earlierDelivered = awaitEarlierDeliveries(
          ctx,
          eventIndex,
          'lock'
        );
        const queueAtGrant = ctx.promiseQueue;
        void queueAtGrant
          .then(() => earlierDelivered)
          .then(() => {
            barrier.markDelivered();
            resolve(slot);
          });
        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'lock_released') {
        if (!acquired) {
          return diverge(event.eventId, 'lock_released before lock_acquired');
        }
        hasReleasedEvent = true;
        ctx.invocationsQueue.delete(correlationId);
        return EventConsumerResult.Finished;
      }

      return diverge(
        event.eventId,
        `unexpected event type "${event.eventType}"`
      );
    });

    return promise;
  };
}
