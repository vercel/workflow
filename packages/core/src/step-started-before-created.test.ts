import { ReplayDivergenceError, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  hasPendingStepOwnedByMessage,
  isStepOwnershipActive,
} from './runtime/step-ownership.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';

/**
 * A queued step's `step_started` can be committed BELOW its `step_created`.
 *
 * Under publish-first fan-out (vercel/workflow#4102) the orchestrator
 * publishes a step's queue message before the batch holding its
 * `step_created` has committed. On a counter-sequenced log (spec 7,
 * workflow-server `SlotSequencer`) the consumer's bare `step_started` takes
 * its position when it reserves a counter block, and nothing re-sequences a
 * start whose patch then runs after the create has committed at a HIGHER
 * position. The log the next replay loads is dense and reads
 *
 *   step_started(X), step_created(X), step_completed(X)
 *
 * with all three under one correlation id. (Model:
 * `workflow-server/specs/StepStartRaceFirstAttempt.cfg`. On the slot-fenced
 * spec 6 scheme the inversion cannot commit.)
 *
 * The replay machinery does not depend on the pair's relative order, and
 * these tests pin that down so the server gap stays a cosmetic one:
 *
 * - `step()` registers its consumer when workflow code calls it, before the
 *   ordered walk can reach ANY event under that correlation id, and the
 *   consumer matches by correlation id, not by class order. The `step_started`
 *   branch in `step.ts` reads the owner stamp and timestamp off the event and
 *   consumes it; it does not require `hasCreatedEvent` to be set already.
 *   The later `step_created` then sets `hasCreatedEvent` as usual.
 * - The events walk only skips an unclaimed event as a duplicate when its
 *   class was ALREADY consumed for the entity, so a `step_created` following
 *   a consumed `step_started` is offered to the live consumer, not skipped.
 * - The suspension handler writes `step_created` only for queue items with
 *   `hasCreatedEvent === false`, and the dispatch table derives ownership
 *   from `hasCreatedEvent` + the latest `step_started` stamp; both are set by
 *   the time the walk reaches the end of the log, whichever came first.
 * - Raw-event scans in the runtime (`pendingStepIds`,
 *   `hasPendingStepOwnedByMessage`) are set-based or latest-wins per
 *   correlation id, so position does not enter.
 *
 * The QuickJS engine is the same: `processEvents` marks the pending op
 * created on `step_created` AND `step_started` alike (`quickjs-runtime.ts`).
 */

const RUN_ID = 'wrun_test';

/**
 * Harness copied from `step-delivery-ordering.test.ts`: the real
 * `EventsConsumer`, the real step consumer, a deterministic VM context, and
 * an unconsumed-event hook that reports the way the runtime does.
 */
function setupWorkflowContext(
  events: Event[],
  replayPayloadCache: ReplayPayloadCache = new ReplayPayloadCache(undefined)
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: RUN_ID,
    encryptionKey: undefined,
    replayPayloadCache,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`
          )
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

// Deterministic correlation IDs from the ULID generator with seed 'test'
// (same sequence as `step-delivery-ordering.test.ts`).
const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
];
const STEP_A = `step_${CORR_IDS[0]}`;
const STEP_B = `step_${CORR_IDS[1]}`;
const AFTER = `step_${CORR_IDS[2]}`;

async function runWithDiscontinuation(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<any>
): Promise<{ result?: any; error?: any }> {
  const workflowDiscontinuation = withResolvers<void>();
  ctx.onWorkflowError = workflowDiscontinuation.reject;
  let result: any;
  let error: any;
  try {
    result = await Promise.race([
      workflowFn(),
      workflowDiscontinuation.promise,
    ]);
  } catch (err) {
    error = err;
  }
  return { result, error };
}

/** Dense, monotonic event ids and timestamps: position i is `evnt_i`. */
function seal(events: Omit<Event, 'eventId' | 'runId' | 'createdAt'>[]) {
  const base = 1753481739458;
  return events.map(
    (e, i) =>
      ({
        ...e,
        eventId: `evnt_${i}`,
        runId: RUN_ID,
        createdAt: new Date(base + 1000 * (i + 1)),
      }) as Event
  );
}

function started(
  correlationId: string,
  stepName: string,
  ownerMessageId?: string
) {
  return {
    eventType: 'step_started' as const,
    correlationId,
    eventData: {
      stepName,
      ...(ownerMessageId !== undefined && { ownerMessageId }),
    },
  };
}

function created(correlationId: string, stepName: string) {
  return {
    eventType: 'step_created' as const,
    correlationId,
    eventData: { stepName },
  };
}

async function completed(
  correlationId: string,
  stepName: string,
  value: unknown
) {
  const ops: Promise<any>[] = [];
  const result = await dehydrateStepReturnValue(value, RUN_ID, undefined, ops);
  await Promise.all(ops);
  return {
    eventType: 'step_completed' as const,
    correlationId,
    eventData: { stepName, result },
  };
}

function stepItem(ctx: WorkflowOrchestratorContext, correlationId: string) {
  const item = ctx.invocationsQueue.get(correlationId);
  if (!item || item.type !== 'step') {
    throw new Error(`no step queue item for ${correlationId}`);
  }
  return item;
}

describe('step_started committed below its step_created', () => {
  it('replays [started, created, completed] to the step result with nothing left to dispatch', async () => {
    const events = seal([
      started(STEP_A, 'stepA'),
      created(STEP_A, 'stepA'),
      await completed(STEP_A, 'stepA', 'ok'),
    ]);
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');

    const { result, error } = await runWithDiscontinuation(ctx, () => stepA());

    expect(error).toBeUndefined();
    expect(result).toBe('ok');
    // Terminal: the consumer removed the queue item, so a suspension handler
    // or dispatch pass running after this replay has no step to create or
    // enqueue (the "not re-dispatched" half).
    expect(ctx.invocationsQueue.size).toBe(0);
    // Every event was claimed in one ordered pass: no unconsumed-event
    // report, no divergence.
    expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
  });

  it('agrees with the normally ordered log [created, started, completed]', async () => {
    const inverted = seal([
      started(STEP_A, 'stepA'),
      created(STEP_A, 'stepA'),
      await completed(STEP_A, 'stepA', 42),
    ]);
    const normal = seal([
      created(STEP_A, 'stepA'),
      started(STEP_A, 'stepA'),
      await completed(STEP_A, 'stepA', 42),
    ]);
    for (const events of [inverted, normal]) {
      const ctx = setupWorkflowContext(events);
      const stepA = createUseStep(ctx)('stepA');
      const { result, error } = await runWithDiscontinuation(ctx, () =>
        stepA()
      );
      expect(error).toBeUndefined();
      expect(result).toBe(42);
      expect(ctx.invocationsQueue.size).toBe(0);
    }
  });

  it('suspends [started, created] as a created, queue-owned step rather than re-creating it', async () => {
    const events = seal([
      started(STEP_A, 'stepA'), // bare start: a queued-message delivery
      created(STEP_A, 'stepA'),
    ]);
    const ctx = setupWorkflowContext(events);
    const stepA = createUseStep(ctx)('stepA');

    const { error } = await runWithDiscontinuation(ctx, () => stepA());

    expect(error).toBeDefined();
    if (!WorkflowSuspension.is(error)) {
      throw error;
    }
    const item = stepItem(ctx, STEP_A);
    // `hasCreatedEvent` is what the suspension handler filters on for
    // `stepsNeedingCreation`: true means no second step_created is written.
    expect(item.hasCreatedEvent).toBe(true);
    // The start was consumed too: its timestamp is the ownership epoch and
    // its (absent) stamp says the step is queue-owned, so the dispatch table
    // takes the plain requeue path exactly as it does for [created, started].
    expect(item.lastStartedAt).toBe(+events[0].createdAt);
    expect(item.ownerMessageId).toBeUndefined();
    expect(isStepOwnershipActive(item)).toBe(false);
    expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
  });

  it('derives inline ownership from a stamped start that precedes the create', async () => {
    const events = seal([
      started(STEP_A, 'stepA', 'msg_owner'),
      created(STEP_A, 'stepA'),
    ]);
    const ctx = setupWorkflowContext(events);
    const stepA = createUseStep(ctx)('stepA');

    const { error } = await runWithDiscontinuation(ctx, () => stepA());

    expect(WorkflowSuspension.is(error)).toBe(true);
    const item = stepItem(ctx, STEP_A);
    expect(item.hasCreatedEvent).toBe(true);
    expect(item.ownerMessageId).toBe('msg_owner');
    expect(isStepOwnershipActive(item)).toBe(true);
    // The raw-event scan the background-step fast path uses agrees: it is a
    // latest-wins pass over step_started per correlation id, blind to where
    // the step_created sits.
    expect(
      hasPendingStepOwnedByMessage(events, new Set([STEP_A]), 'msg_owner')
    ).toBe(true);
    expect(
      hasPendingStepOwnedByMessage(events, new Set([STEP_A]), 'msg_other')
    ).toBe(false);
  });

  it('keeps sibling ordering intact when one branch of a fan-out is inverted', async () => {
    // Two branches; branch A's pair is inverted, branch B's is not. Both
    // results are in the log, so the continuation `after` was created by the
    // live run and its step_created must match the consumer this replay
    // registers for it, which is only possible if both branches resolved.
    const events = seal([
      created(STEP_B, 'stepB'),
      started(STEP_A, 'stepA'),
      created(STEP_A, 'stepA'),
      started(STEP_B, 'stepB'),
      await completed(STEP_A, 'stepA', 'a'),
      await completed(STEP_B, 'stepB', 'b'),
      created(AFTER, 'after'),
    ]);
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');
    const after = useStep('after');

    const { error } = await runWithDiscontinuation(ctx, async () => {
      const [a, b] = await Promise.all([stepA(), stepB()]);
      expect(a).toBe('a');
      expect(b).toBe('b');
      await after();
    });

    expect(error).toBeDefined();
    if (!WorkflowSuspension.is(error)) {
      throw error;
    }
    expect([...ctx.invocationsQueue.keys()]).toEqual([AFTER]);
    expect(stepItem(ctx, AFTER).hasCreatedEvent).toBe(true);
    expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
  });

  it('still applies the step-name fence to a start that precedes the create', async () => {
    // Tolerating the order must not weaken the divergence check: a
    // step_started whose recorded stepName belongs to another step is
    // divergence whichever side of the step_created it sits on.
    const events = seal([
      started(STEP_A, 'someOtherStep'),
      created(STEP_A, 'stepA'),
    ]);
    const ctx = setupWorkflowContext(events);
    const stepA = createUseStep(ctx)('stepA');

    const { error } = await runWithDiscontinuation(ctx, () => stepA());

    expect(error).toBeInstanceOf(ReplayDivergenceError);
    expect(String(error)).toMatch(
      /step_started for step_.* belongs to "someOtherStep"/
    );
  });
});
