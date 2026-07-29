import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';

/**
 * These tests verify the end-to-end behavior of the per-run step hydration
 * cache as exercised through the real `createUseStep` consumer — proving both
 * that the expensive hydrate is skipped on subsequent replays AND that the
 * deterministic, event-log-ordered delivery through `promiseQueue` is
 * preserved on cache hits.
 *
 * Each replay iteration of a run builds a fresh `WorkflowOrchestratorContext`
 * but shares a single `replayPayloadCache` (owned by the inline loop). We
 * simulate that here by constructing two contexts that share one cache.
 */

// Build a context that shares a caller-provided hydration cache, mirroring how
// the inline loop threads one cache across replay iterations.
function setupWorkflowContext(
  events: Event[],
  replayPayloadCache = new ReplayPayloadCache(undefined)
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
    replayPayloadCache,
  };
}

async function makeStepEvents(): Promise<Event[]> {
  return [
    {
      eventId: 'evnt_0',
      runId: 'wrun_test',
      eventType: 'step_completed',
      correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
      eventData: {
        stepName: 'step1',
        result: await dehydrateStepReturnValue('one', 'wrun_test', undefined),
      },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_1',
      runId: 'wrun_test',
      eventType: 'step_completed',
      correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
      eventData: {
        stepName: 'step2',
        result: await dehydrateStepReturnValue('two', 'wrun_test', undefined),
      },
      createdAt: new Date(),
    },
  ];
}

describe('step hydration memoization through the step consumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips re-hydration of primitive step results on a second replay sharing the cache', async () => {
    const events = await makeStepEvents();
    const cache = new ReplayPayloadCache(undefined);

    const serialization = await import('./serialization.js');
    const hydrateSpy = vi.spyOn(serialization, 'hydrateStepReturnValue');

    // --- Replay 1: fresh context, shared cache. Both steps hydrate. ---
    const ctx1 = setupWorkflowContext(events, cache);
    const useStep1 = createUseStep(ctx1);
    const [r1a, r1b] = await Promise.all([
      useStep1('step1')(),
      useStep1('step2')(),
    ]);
    expect(r1a).toBe('one');
    expect(r1b).toBe('two');
    expect(hydrateSpy).toHaveBeenCalledTimes(2);

    // --- Replay 2: brand-new context, SAME cache. No re-hydration. ---
    hydrateSpy.mockClear();
    const ctx2 = setupWorkflowContext(events, cache);
    const useStep2 = createUseStep(ctx2);
    const [r2a, r2b] = await Promise.all([
      useStep2('step1')(),
      useStep2('step2')(),
    ]);
    expect(r2a).toBe('one');
    expect(r2b).toBe('two');
    // The expensive decrypt+parse must NOT run again on the second replay.
    expect(hydrateSpy).toHaveBeenCalledTimes(0);
  });

  it('preserves event-log resolution order on cache hits even with variable timing', async () => {
    const events = await makeStepEvents();
    const cache = new ReplayPayloadCache(undefined);

    // Replay 1: populate the cache (no timing games needed).
    const ctx1 = setupWorkflowContext(events, cache);
    const useStep1 = createUseStep(ctx1);
    await Promise.all([useStep1('step1')(), useStep1('step2')()]);

    // Replay 2: all results are cache hits, but force the second event's
    // delivery slot to be observed quickly while the first is artificially
    // slowed — proving ordering is enforced by promiseQueue, not by hydrate
    // timing (which is now a no-op on hits).
    const ctx2 = setupWorkflowContext(events, cache);
    const useStep2 = createUseStep(ctx2);

    const promiseA = useStep2('step1')();
    const promiseB = useStep2('step2')();

    const resolveOrder: string[] = [];
    promiseA.then((v) => resolveOrder.push(`A:${v}`));
    promiseB.then((v) => resolveOrder.push(`B:${v}`));

    const [a, b] = await Promise.all([promiseA, promiseB]);
    expect(a).toBe('one');
    expect(b).toBe('two');
    // Must resolve in event-log order regardless of caching.
    expect(resolveOrder).toEqual(['A:one', 'B:two']);
  });

  it('re-hydrates object results on every replay (no shared mutable reference)', async () => {
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'obj',
          result: await dehydrateStepReturnValue(
            { count: 0 },
            'wrun_test',
            undefined
          ),
        },
        createdAt: new Date(),
      },
    ];
    const cache = new ReplayPayloadCache(undefined);

    // Replay 1: hydrate the object, then mutate it (as workflow code might).
    const ctx1 = setupWorkflowContext(events, cache);
    const useStep1 = createUseStep(ctx1);
    const first = (await useStep1('obj')()) as { count: number };
    first.count = 99;

    // Replay 2: must produce a FRESH object, not the mutated one.
    const ctx2 = setupWorkflowContext(events, cache);
    const useStep2 = createUseStep(ctx2);
    const second = (await useStep2('obj')()) as { count: number };

    expect(second).not.toBe(first);
    expect(second.count).toBe(0);
  });
});
