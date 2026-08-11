/**
 * The scheduler.
 *
 * Take the next queue message, jump the virtual clock to its delivery time,
 * hand it to the flow handler, wait for it to finish, repeat until the queue
 * is empty or a budget says stop. That single loop is the whole of "nothing in
 * this world happens on its own".
 *
 * It lives apart from `scenario.ts` because two things drive it: a scenario,
 * and the replay verification that cold-starts a second world from the first
 * one's committed log.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkflowUrl } from '@workflow/utils';
import { encodeMessage, type QueuedMessage } from './queue.js';
import type { PendingMessageView } from './types.js';
import type { SimWorld } from './world.js';

export interface ScenarioLimits {
  /** Maximum queue deliveries before the scenario is abandoned. */
  maxDeliveries?: number;
  /** Maximum span of virtual time the scenario may cover. */
  maxVirtualMs?: number;
  /** Wall-clock guard against a genuinely non-terminating step body. */
  maxWallMs?: number;
  /**
   * Wall-clock budget for a single `Writer.runTo*` wait.
   *
   * Deliberately far below `maxWallMs`: a `runTo` that blows its budget can say
   * which writer failed to reach which point and where every other writer was
   * standing, and that diagnosis is worth much more than the generic
   * "the scenario ran out of wall clock" the global deadline can offer. It is
   * clamped to `maxWallMs` so a scenario that lowers the global budget does not
   * have to remember to lower this one too.
   */
  maxRunToWallMs?: number;
}

export const DEFAULT_LIMITS: Required<ScenarioLimits> = {
  maxDeliveries: 200,
  // A year of virtual time. Long enough for any realistic sleep chain, short
  // enough that a runaway `while (true) { await sleep('1d') }` is caught.
  maxVirtualMs: 365 * 24 * 60 * 60 * 1000,
  maxWallMs: 60_000,
  // Everything in this world is in-memory, so a point that is reachable at all
  // is reached in milliseconds. Seconds of grace is generous.
  maxRunToWallMs: 5_000,
};

/**
 * Let the JS event loop settle.
 *
 * The runtime uses zero-delay macrotasks as ordering barriers in the replay
 * consumer, and `waitUntil`-style background work is not awaited by anyone.
 * Between deliveries we drain both so the next delivery starts from a quiet
 * process — otherwise a message enqueued from a trailing microtask would be
 * missed and the scenario would report a spurious stall.
 */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await sleep(0);
  }
}

/** Scenario-supplied override for which pending message goes next. */
export type SelectNext = (pending: PendingMessageView[]) => string | undefined;

export interface DriveResult {
  deliveries: number;
  /** Set to the reason when a budget stopped the loop rather than quiescence. */
  exceeded?: string;
}

/**
 * The scheduler.
 *
 * Take the next message, jump the clock to its delivery time, hand it to the
 * flow handler, repeat until the queue is empty or a budget says stop. This is
 * the whole of "nothing happens on its own" — extracted so the replay
 * verification can drive a second world through exactly the same loop.
 */
export async function driveQueue(options: {
  world: SimWorld;
  limits: Required<ScenarioLimits>;
  wallStart: number;
  selectNext?: SelectNext;
}): Promise<DriveResult> {
  const { world, limits, wallStart } = options;
  let deliveries = 0;

  while (true) {
    await settle();

    if (performanceNow() - wallStart > limits.maxWallMs) {
      return {
        deliveries,
        exceeded: `wall-clock budget exceeded (${limits.maxWallMs}ms) — a step body is probably not terminating`,
      };
    }

    const message = selectMessage(world, options.selectNext);
    if (!message) break;

    if (deliveries >= limits.maxDeliveries) {
      world.simQueue.requeue(message, message.readyAtMs);
      return {
        deliveries,
        exceeded: `delivery budget exceeded (${limits.maxDeliveries} deliveries)`,
      };
    }

    world.clock.advanceTo(message.readyAtMs);
    if (world.clock.elapsed() > limits.maxVirtualMs) {
      world.simQueue.requeue(message, message.readyAtMs);
      return {
        deliveries,
        exceeded: `virtual-time budget exceeded (${limits.maxVirtualMs}ms) — the run keeps rescheduling itself into the future`,
      };
    }

    deliveries++;
    await deliver(world, message);
  }

  await settle();
  return { deliveries };
}

/**
 * Pick the next message to deliver: the scenario's choice when it made one and
 * that message is still pending, otherwise the default (earliest ready, then
 * enqueue order).
 */
function selectMessage(
  world: SimWorld,
  selectNext: SelectNext | undefined
): QueuedMessage | undefined {
  if (selectNext) {
    const chosen = selectNext(world.simQueue.view());
    if (chosen) {
      const message = world.simQueue.takeById(chosen);
      if (message) return message;
      world.pushTrace({
        kind: 'warn',
        message: `selectNext chose ${chosen}, which is not pending; falling back to the default order`,
      });
    }
  }
  return world.simQueue.takeNext();
}

/**
 * Hand one message to the flow handler and apply the queue's response
 * protocol: `{ timeoutSeconds }` reschedules the same message (same
 * `messageId`, which the runtime's inline step-ownership lease depends on),
 * a non-2xx redelivers after a backoff, anything else settles it.
 */
export async function deliver(
  world: SimWorld,
  message: QueuedMessage
): Promise<void> {
  const handler = world.simQueue.handlerFor(message.queueName);
  if (!handler) {
    world.pushTrace({
      kind: 'warn',
      message: `no handler registered for queue ${message.queueName}; message dropped`,
    });
    world.simQueue.settle(message);
    return;
  }

  message.deliveries++;
  const payload = message.payload as { stepId?: string };
  world.pushTrace({
    kind: 'delivery',
    message: `deliver ${message.messageId} attempt ${message.deliveries}${
      payload.stepId ? ` (inline step ${payload.stepId})` : ''
    }`,
  });

  const request = new Request(
    createWorkflowUrl('http://sim.local', { type: 'flow' }),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': message.queueName,
        'x-vqs-message-id': message.messageId,
        'x-vqs-message-attempt': String(message.deliveries),
      },
      body: encodeMessage(message.payload),
    }
  );

  const response = await handler(request);
  const text = await response.text();

  if (response.ok) {
    let timeoutSeconds: number | undefined;
    try {
      const parsed = Number(JSON.parse(text).timeoutSeconds);
      if (Number.isFinite(parsed) && parsed >= 0) timeoutSeconds = parsed;
    } catch {
      // Not a timeout response.
    }
    if (timeoutSeconds !== undefined) {
      world.simQueue.requeue(
        message,
        world.clock.now() + timeoutSeconds * 1000
      );
      return;
    }
    world.simQueue.settle(message);
    return;
  }

  world.pushTrace({
    kind: 'warn',
    message: `handler returned HTTP ${response.status} for ${message.messageId}: ${text}`,
  });
  // Mirror world-local's flat 5s retry spacing. The real cap lives in the
  // runtime (MAX_QUEUE_DELIVERIES); the scenario's delivery budget is the
  // backstop.
  world.simQueue.requeue(message, world.clock.now() + 5_000);
}

/** Real elapsed time, immune to the virtual `Date` patch. */
export function performanceNow(): number {
  return performance.now();
}
