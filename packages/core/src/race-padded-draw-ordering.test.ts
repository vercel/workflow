/**
 * Reproduction attempt for the residual CORRUPTED_EVENT_LOG shape observed on
 * spec-6 (slot-identity) runs, most recently
 * `wrun_41KZYJ92TP0GYBNDKW3FJBWQ3Y` (step-storm repro on preview,
 * 2026-08-13): concurrent writers bound the same drawn correlation id to
 * different steps (`step_…QMWZ` = finalizeStep at slot 630 vs the canonical
 * replay's releaseStep), and one logical finalize step was created and
 * executed under multiple ids.
 *
 * The workflow shape in that run is `Promise.race([settleStep(), sleep(t)])`
 * per branch: the watchdog path draws two follow-up ids (recover, finalize)
 * where the settled path draws one (finalize). The race adds microtask hops
 * BETWEEN a step result's barrier-ordered resolution and the branch's next
 * draw — exactly the "padded consumer" residual that
 * `step-delivery-ordering.test.ts` calls out of scope and
 * `step-delivery-hop-count.test.ts` pins for plain awaits.
 *
 * Two orderings are asserted, cold and warm (shared ReplayPayloadCache):
 *
 *  1. A wait-woken branch's draw (recover) vs a step-woken branch's draw
 *     (finalize) with the wait earlier in the log — the covered class, with
 *     race padding on both consumers.
 *  2. The settled branch's finalize draw (step_completed at slot i) vs the
 *     watchdog branch's finalize draw (recover step_completed at slot j > i)
 *     — the inversion the failed run's writer actually committed (its
 *     settled-branch finalize minted AFTER all recovery finalizes).
 */
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createSleep } from './workflow/sleep.js';

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
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}.`
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

// Deterministic correlation IDs from the ULID generator with seed 'test'.
// Draw order in the body below:
//   c0 = settleW (branch W's raced step)
//   c1 = sleepW  (branch W's watchdog)
//   c2 = settleS (branch S's raced step)
//   c3 = sleepS  (branch S's watchdog)
//   c4..c6 = the follow-up draws whose order is under test
const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
  '01K11TFZ62YS0YYFDQ3E8B9YCZ',
  '01K11TFZ62YS0YYFDQ3E8B9YD0',
  '01K11TFZ62YS0YYFDQ3E8B9YD1',
];

const WATCHDOG = Symbol.for('race-padded-draw-ordering:watchdog');

function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
  return [...ctx.invocationsQueue.values()]
    .filter((item) => item.type === 'step')
    .map((item) => (item.type === 'step' ? item.stepName : ''));
}

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

function delayHydration() {
  const hydrateSpy = vi.fn();
  return {
    hydrateSpy,
    install: async () => {
      const serialization = await import('./serialization.js');
      const originalHydrate = serialization.hydrateStepReturnValue;
      return vi
        .spyOn(serialization, 'hydrateStepReturnValue')
        .mockImplementation(async (...args) => {
          hydrateSpy();
          await new Promise((r) => setTimeout(r, 10));
          return originalHydrate(...args);
        });
    },
  };
}

describe('race-padded consumers draw in event-log order', () => {
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  const resumeAtW = new Date('2026-07-27T12:00:05.000Z');
  const resumeAtS = new Date('2026-07-27T12:00:06.000Z');

  /**
   * The live invocation's history, exactly as the failed run's final round
   * recorded it (two branches instead of eight):
   *
   * - branch W's watchdog fired first (wait_completed lowest),
   *   so W drew c4 = recoverStep;
   * - branch S's raced step then completed, so S drew c5 = finalizeS;
   * - W's recover completed last, so W drew c6 = finalizeW.
   */
  async function buildEventLog(): Promise<Event[]> {
    const ops: Promise<any>[] = [];
    const [settleSResult, recoverResult] = await Promise.all([
      dehydrateStepReturnValue('settled', 'wrun_test', undefined, ops),
      dehydrateStepReturnValue('recovered', 'wrun_test', undefined, ops),
    ]);

    const at = () => new Date();
    return [
      // Round setup: both branches suspend together.
      {
        eventId: 'evnt_00',
        runId: 'wrun_test',
        eventType: 'step_created',
        correlationId: `step_${CORR_IDS[0]}`,
        eventData: { stepName: 'settleW' },
        createdAt: at(),
      },
      {
        eventId: 'evnt_01',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtW },
        createdAt: at(),
      },
      {
        eventId: 'evnt_02',
        runId: 'wrun_test',
        eventType: 'step_created',
        correlationId: `step_${CORR_IDS[2]}`,
        eventData: { stepName: 'settleS' },
        createdAt: at(),
      },
      {
        eventId: 'evnt_03',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: `wait_${CORR_IDS[3]}`,
        eventData: { resumeAt: resumeAtS },
        createdAt: at(),
      },
      {
        eventId: 'evnt_04',
        runId: 'wrun_test',
        eventType: 'step_started',
        correlationId: `step_${CORR_IDS[0]}`,
        eventData: { stepName: 'settleW' },
        createdAt: at(),
      },
      {
        eventId: 'evnt_05',
        runId: 'wrun_test',
        eventType: 'step_started',
        correlationId: `step_${CORR_IDS[2]}`,
        eventData: { stepName: 'settleS' },
        createdAt: at(),
      },
      // Branch W's watchdog fires: W's race resolves 'watchdog', W draws c4.
      {
        eventId: 'evnt_06',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtW },
        createdAt: at(),
      },
      // Branch S's raced step completes: S's race resolves 'settled',
      // S draws c5. Hydration-sensitive delivery.
      {
        eventId: 'evnt_07',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: `step_${CORR_IDS[2]}`,
        eventData: { stepName: 'settleS', result: settleSResult },
        createdAt: at(),
      },
      // W's recovery step, drawn at evnt_06.
      {
        eventId: 'evnt_08',
        runId: 'wrun_test',
        eventType: 'step_created',
        correlationId: `step_${CORR_IDS[4]}`,
        eventData: { stepName: 'recoverW' },
        createdAt: at(),
      },
      {
        eventId: 'evnt_09',
        runId: 'wrun_test',
        eventType: 'step_started',
        correlationId: `step_${CORR_IDS[4]}`,
        eventData: { stepName: 'recoverW' },
        createdAt: at(),
      },
      {
        eventId: 'evnt_10',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: `step_${CORR_IDS[4]}`,
        eventData: { stepName: 'recoverW', result: recoverResult },
        createdAt: at(),
      },
      // S's finalize, drawn at evnt_07 — BEFORE W's finalize in ULID order.
      {
        eventId: 'evnt_11',
        runId: 'wrun_test',
        eventType: 'step_created',
        correlationId: `step_${CORR_IDS[5]}`,
        eventData: { stepName: 'finalizeS' },
        createdAt: at(),
      },
      // W's finalize, drawn at evnt_10.
      {
        eventId: 'evnt_12',
        runId: 'wrun_test',
        eventType: 'step_created',
        correlationId: `step_${CORR_IDS[6]}`,
        eventData: { stepName: 'finalizeW' },
        createdAt: at(),
      },
    ];
  }

  function workflowBody(ctx: WorkflowOrchestratorContext) {
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    return async () => {
      const settleW = useStep('settleW');
      const settleS = useStep('settleS');
      const recoverW = useStep('recoverW');
      const finalizeW = useStep('finalizeW');
      const finalizeS = useStep('finalizeS');

      const branchW = (async () => {
        const winner = await Promise.race([
          settleW(),
          sleep(resumeAtW).then(() => WATCHDOG),
        ]);
        if (winner === WATCHDOG) {
          await recoverW();
        }
        await finalizeW();
      })();

      const branchS = (async () => {
        const winner = await Promise.race([
          settleS(),
          sleep(resumeAtS).then(() => WATCHDOG),
        ]);
        if (winner === WATCHDOG) {
          throw new Error('branch S must settle in this log');
        }
        await finalizeS();
      })();

      await Promise.all([branchW, branchS]);
    };
  }

  async function assertLogOrderReproduced(
    events: Event[],
    cache: ReplayPayloadCache
  ) {
    const ctx = setupWorkflowContext(events, cache);
    const { error } = await runWithDiscontinuation(ctx, workflowBody(ctx));
    expect(error).toBeDefined();
    if (!WorkflowSuspension.is(error)) {
      throw error;
    }
    // Correct behavior: the replay agrees with every committed binding.
    // `settleW` stays pending — it lost its race and never completed, so its
    // consumer legitimately outlives the round.
    expect(pendingStepNames(ctx).sort()).toEqual([
      'finalizeS',
      'finalizeW',
      'settleW',
    ]);
    expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
  }

  it('reproduces the recorded draw order on a cold replay', async () => {
    const hydration = delayHydration();
    spy = await hydration.install();
    const events = await buildEventLog();
    await assertLogOrderReproduced(events, new ReplayPayloadCache(undefined));
  });

  it('reproduces the recorded draw order on a warm replay sharing the payload cache', async () => {
    const hydration = delayHydration();
    spy = await hydration.install();
    const events = await buildEventLog();
    const sharedCache = new ReplayPayloadCache(undefined);
    // Cold pass primes the cache the way the first replay of a queue
    // delivery does.
    await assertLogOrderReproduced(events, sharedCache);
    expect(hydration.hydrateSpy).toHaveBeenCalled();
    // Warm pass: the memoized primitive result now resolves in fewer hops
    // than the wait, which is the asymmetry that reordered draws in
    // production.
    await assertLogOrderReproduced(events, sharedCache);
  });
});
