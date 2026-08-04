import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
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
 * ids. These fixtures derive theirs instead, so they say something about the
 * minting primitives rather than about a captured snapshot of them.
 */

const SEED = 'test';
const FIXED_TIMESTAMP = 1753481739458;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: SEED,
    fixedTimestamp: FIXED_TIMESTAMP,
  });
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
  before?: (ctx: WorkflowOrchestratorContext) => void
): string {
  const ctx = setupWorkflowContext([]);
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
    // Under one sequence shared by every kind, the hook and the sleep consume
    // the two ordinals the step would otherwise have drawn, so a replay that
    // disagreed about either renamed the step.
    expect(probeStepId(createHookAndSleep)).toBe(probeStepId());
  });

  it('consumes a step_completed authored with the derived id', async () => {
    const correlationId = probeStepId(createHookAndSleep);
    const ctx = setupWorkflowContext([
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
    ]);
    createHookAndSleep(ctx);
    await expect(createUseStep(ctx)('add')(1, 2)).resolves.toBe(3);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });
});
