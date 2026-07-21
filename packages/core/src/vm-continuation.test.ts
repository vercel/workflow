import { ReplayDivergenceError } from '@workflow/errors';
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
 * Focused tests for the in-process VM-continuation primitive: after new events
 * are appended to a run's log, {@link EventsConsumer.resume} re-drives the SAME
 * live step consumers so the workflow body advances — instead of rebuilding the
 * VM and replaying from event 0. These exercise the resume mechanic and its
 * prefix-divergence guard directly through the real `createUseStep` consumer.
 *
 * The correlation IDs used here (`step_01K11TFZ62YS0YYFDQ3E8B9YCV` /`…YCW`) are
 * the first two IDs the deterministic monotonic ULID factory produces for seed
 * `'test'` at the pinned timestamp — the same anchoring as
 * `step-hydration-memoization.test.ts`.
 */

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const holder = { current: Promise.resolve() };
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => holder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    get promiseQueue() {
      return holder.current;
    },
    set promiseQueue(value: Promise<void>) {
      holder.current = value;
    },
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
    replayPayloadCache: new ReplayPayloadCache(undefined),
  };
}

async function stepCompleted(
  eventId: string,
  correlationId: string,
  stepName: string,
  result: unknown
): Promise<Event> {
  return {
    eventId,
    runId: 'wrun_test',
    eventType: 'step_completed',
    correlationId,
    eventData: {
      stepName,
      result: await dehydrateStepReturnValue(result, 'wrun_test', undefined),
    },
    createdAt: new Date(),
  } as Event;
}

const STEP1 = 'step_01K11TFZ62YS0YYFDQ3E8B9YCV';
const STEP2 = 'step_01K11TFZ62YS0YYFDQ3E8B9YCW';

// Flush pending microtasks + the process.nextTick(consume) re-drive.
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('VM continuation: EventsConsumer.resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advances a live workflow across appended events without rebuilding the VM', async () => {
    // Start with an empty log — the same live context/consumer is reused for
    // the whole run, exactly as the continuation path keeps it alive.
    const events: Event[] = [];
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);

    const order: string[] = [];
    // A sequential two-step workflow body running in ONE live VM.
    const body = (async () => {
      const a = await useStep('step1')();
      order.push(`a:${a}`);
      const b = await useStep('step2')();
      order.push(`b:${b}`);
      return `${a}-${b}`;
    })();

    // step1 is pending (its event isn't in the log yet) — the body is parked.
    await flush();
    expect(order).toEqual([]);

    // Append step1's completion and resume the SAME consumer.
    events.push(await stepCompleted('evnt_0', STEP1, 'step1', 'one'));
    ctx.eventsConsumer.resume(events);
    await flush();
    // The body advanced to (and parked on) step2 in the same VM.
    expect(order).toEqual(['a:one']);

    // Append step2's completion and resume again — body runs to completion.
    events.push(await stepCompleted('evnt_1', STEP2, 'step2', 'two'));
    ctx.eventsConsumer.resume(events);
    expect(await body).toBe('one-two');
    expect(order).toEqual(['a:one', 'b:two']);
  });

  it('throws ReplayDivergenceError when the consumed prefix no longer matches the log', async () => {
    const events: Event[] = [
      await stepCompleted('evnt_0', STEP1, 'step1', 'one'),
      await stepCompleted('evnt_1', STEP2, 'step2', 'two'),
    ];
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);

    // Consume both events (eventIndex advances to 2).
    const [a, b] = await Promise.all([useStep('step1')(), useStep('step2')()]);
    expect([a, b]).toEqual(['one', 'two']);

    // A log whose already-consumed prefix diverges (different eventId at 0)
    // must be rejected so the caller falls back to a full replay.
    const diverged: Event[] = [
      { ...events[0], eventId: 'evnt_DIFFERENT' },
      events[1],
    ];
    expect(() => ctx.eventsConsumer.resume(diverged)).toThrow(
      ReplayDivergenceError
    );
  });

  it('accepts an identical prefix (no divergence) and is a no-op past the cursor', async () => {
    const events: Event[] = [
      await stepCompleted('evnt_0', STEP1, 'step1', 'x'),
    ];
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    expect(await useStep('step1')()).toBe('x');

    // Re-driving with the same prefix and no new events must not throw.
    expect(() => ctx.eventsConsumer.resume([...events])).not.toThrow();
  });
});
