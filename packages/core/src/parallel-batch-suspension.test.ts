/**
 * Companion to `delivery-barrier-coverage.test.ts`, covering the suspension
 * side of the delivery-barrier registry: a `WorkflowSuspension` must not be
 * raised while a delivery that is committed to reaching the workflow (see
 * `resolvesOnItsOwn` in `private.ts`) has not yet been delivered.
 *
 * The regression shape is a run with an outstanding fire-and-forget `sleep()`
 * that replays a batch of PARALLEL step results. Each `step_completed` in the
 * batch releases `pendingDeliveries` inside its serial queue slot, but the
 * `resolve()` runs from a detached continuation behind
 * `awaitEarlierDeliveries` — and every step after the first pays that
 * deferral's macrotask yield (the step-behind-step edge in `DEFER_BEHIND`).
 * The pending sleep reaches the end of the log and arms `scheduleWhenIdle`
 * during the same drain window, so its idle check can observe
 * `pendingDeliveries === 0` while those step results are hydrated but still
 * parked. The suspension then fires before the workflow's `Promise.all`
 * continuation has run: it carries no step invocations, the runtime queues
 * nothing, and the run goes dormant until an unrelated timer (the sleep
 * itself) happens to revive it.
 *
 * A single-step batch never defers (`earlier.length === 0`), resolves on
 * microtasks before the idle check's own macrotask, and is unaffected — which
 * is why the serial control below passes either way.
 */
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createSleep } from './workflow/sleep.js';

const FIXED_TIMESTAMP = 1753481739458;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(`Unconsumed event: ${event.eventType}`)
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  ctxRef.current = ctx;
  return ctx;
}

/**
 * The ULIDs the seeded generator hands out, in invocation order. Correlation
 * IDs in the fixtures below have to match what the replayed workflow draws.
 */
function deterministicUlids(count: number): string[] {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return Array.from({ length: count }, () => ulid(workflowStartedAt));
}

const ULIDS = deterministicUlids(8);

async function replay(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<unknown>
): Promise<unknown> {
  const discontinuation = withResolvers<void>();
  ctx.onWorkflowError = discontinuation.reject;
  try {
    await Promise.race([workflowFn(), discontinuation.promise]);
  } catch (err) {
    return err;
  }
  return undefined;
}

/**
 * Assert the replay suspended AND that the suspension itself carries the
 * expected step invocations. The snapshot is taken from the
 * `WorkflowSuspension` (constructed from the invocations queue at raise
 * time), not from the live queue, so a suspension raised before the batch's
 * continuations queued their follow-up work fails here with `[]` — exactly
 * what the runtime would see before deciding it has nothing to schedule.
 */
function expectSuspensionCarryingSteps(error: unknown, expected: string[]) {
  if (!WorkflowSuspension.is(error)) {
    throw new Error(
      error === undefined
        ? 'expected the replay to suspend, but it completed'
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error }
    );
  }
  expect(
    (error as WorkflowSuspension).steps.flatMap((item) =>
      item.type === 'step' ? [item.stepName] : []
    )
  ).toEqual(expected);
}

const event = (
  eventId: string,
  eventType: string,
  correlationId: string,
  eventData: Record<string, unknown>
): Event =>
  ({
    eventId,
    runId: 'wrun_test',
    eventType,
    correlationId,
    eventData,
    createdAt: new Date(),
  }) as Event;

describe('suspension with a pending sleep and a parallel step batch', () => {
  it('carries the follow-up step queued after the batch resolves', async () => {
    const resumeAt = new Date(FIXED_TIMESTAMP + 25 * 60_000);
    const ops: Promise<unknown>[] = [];
    const [stepAResult, stepBResult, stepCResult] = await Promise.all([
      dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
      dehydrateStepReturnValue('b', 'wrun_test', undefined, ops),
      dehydrateStepReturnValue('c', 'wrun_test', undefined, ops),
    ]);

    const events: Event[] = [
      event('evnt_0', 'wait_created', `wait_${ULIDS[0]}`, { resumeAt }),
      event('evnt_1', 'step_created', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
      }),
      event('evnt_2', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
      }),
      event('evnt_3', 'step_created', `step_${ULIDS[3]}`, {
        stepName: 'stepC',
      }),
      event('evnt_4', 'step_started', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
      }),
      event('evnt_5', 'step_started', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
      }),
      event('evnt_6', 'step_started', `step_${ULIDS[3]}`, {
        stepName: 'stepC',
      }),
      event('evnt_7', 'step_completed', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
        result: stepAResult,
      }),
      event('evnt_8', 'step_completed', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
        result: stepBResult,
      }),
      event('evnt_9', 'step_completed', `step_${ULIDS[3]}`, {
        stepName: 'stepC',
        result: stepCResult,
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    const error = await replay(ctx, async () => {
      // Fire-and-forget watchdog: never awaited, never completes in-run. Its
      // subscriber reaches the end of the log and arms the idle check on
      // every replay.
      sleep('25m').catch(() => {});

      const stepA = useStep('stepA');
      const stepB = useStep('stepB');
      const stepC = useStep('stepC');
      const stepD = useStep('stepD');

      await Promise.all([stepA(), stepB(), stepC()]);
      await stepD();
    });

    expectSuspensionCarryingSteps(error, ['stepD']);
  });

  it('control: a serial batch still carries its follow-up step', async () => {
    const resumeAt = new Date(FIXED_TIMESTAMP + 25 * 60_000);
    const ops: Promise<unknown>[] = [];
    const stepAResult = await dehydrateStepReturnValue(
      'a',
      'wrun_test',
      undefined,
      ops
    );

    const events: Event[] = [
      event('evnt_0', 'wait_created', `wait_${ULIDS[0]}`, { resumeAt }),
      event('evnt_1', 'step_created', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
      }),
      event('evnt_2', 'step_started', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
      }),
      event('evnt_3', 'step_completed', `step_${ULIDS[1]}`, {
        stepName: 'stepA',
        result: stepAResult,
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    const error = await replay(ctx, async () => {
      sleep('25m').catch(() => {});

      const stepA = useStep('stepA');
      const stepD = useStep('stepD');

      await stepA();
      await stepD();
    });

    expectSuspensionCarryingSteps(error, ['stepD']);
  });
});
