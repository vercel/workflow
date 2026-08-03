import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { createCorrelationIdGenerator } from './correlation-id.js';
import { EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * Correlation-id stability seen through the primitives that actually mint ids,
 * rather than through the generator alone: that a step's id survives another
 * kind of entity being created alongside it, and that a replay consumes an event
 * log carrying the ids a same-seeded replay derives.
 *
 * The rest of the replay suites author their event logs with literal correlation
 * ids from the shared sequence and pin themselves to it. These fixtures derive
 * their ids instead, so they hold under either scheme.
 */

const SEED = 'test';
const FIXED_TIMESTAMP = 1753481739458;

function setupWorkflowContext(
  events: Event[],
  perKind: boolean
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: SEED,
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateCorrelationId: createCorrelationIdGenerator({
      seed: SEED,
      fixedTimestamp: FIXED_TIMESTAMP,
      positional: () => ulid(FIXED_TIMESTAMP),
      perKind,
    }),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
}

/**
 * The id the next step of a replay would claim. Nothing in the log resolves the
 * step, so the returned promise stays pending by design: the queue item is what
 * we are after.
 */
function probeStepId(
  perKind: boolean,
  before?: (ctx: WorkflowOrchestratorContext) => void
): string {
  const ctx = setupWorkflowContext([], perKind);
  before?.(ctx);
  void createUseStep(ctx)('add')(1, 2).catch(() => {});
  const item = [...ctx.invocationsQueue.values()].find(
    (entry) => entry.type === 'step'
  );
  if (!item) {
    throw new Error('expected a step invocation');
  }
  return item.correlationId;
}

function createHookAndSleep(ctx: WorkflowOrchestratorContext): void {
  createCreateHook(ctx)();
  void createSleep(ctx)('1h').catch(() => {});
}

describe('correlation ids through the replay primitives', () => {
  it('keeps a step id when a hook and a sleep are created before it', () => {
    expect(probeStepId(true, createHookAndSleep)).toBe(probeStepId(true));
  });

  it('renumbers that step under one sequence shared by every kind', () => {
    // The failure this PR removes, and the reason the assertion above is worth
    // making: with a shared sequence the hook and the sleep consume the two
    // ordinals the step would otherwise have drawn from.
    expect(probeStepId(false, createHookAndSleep)).not.toBe(probeStepId(false));
  });

  it('consumes a step_completed authored with the derived id', async () => {
    const correlationId = probeStepId(true, createHookAndSleep);
    const ctx = setupWorkflowContext(
      [
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId,
          eventData: {
            stepName: 'add',
            result: await dehydrateStepReturnValue(3, 'wrun_test', undefined),
          },
          createdAt: new Date(),
        },
      ],
      true
    );
    createHookAndSleep(ctx);
    await expect(createUseStep(ctx)('add')(1, 2)).resolves.toBe(3);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });
});
