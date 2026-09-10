/**
 * Unit coverage for the barrier safety-net dispenser (`ensureBarrierSafetyNet`
 * in private.ts) — the pieces of vercel/workflow#3554 that previously only
 * end-to-end storm lanes exercised:
 *
 *  1. End-of-log suspension must not preempt deliveries parked behind an
 *     unclaimed buffered hook payload. The pass suspends only after the
 *     parked chain delivered and the woken branch made its follow-up draws
 *     (the regression surfaced as whole storm runs going dormant/`stuck`).
 *  2. With SEVERAL parked segments, chains must wake in log order — the
 *     dispenser retires heads lowest-first and re-blocks while a woken chain
 *     drains, so the ULIDs the branches draw next are position-determined,
 *     not net-timing-determined.
 *  3. The dispenser must survive a rejected `promiseQueue`: the registry now
 *     gates `isDeliveryIdle`, so a silently-dead dispenser would wedge the
 *     run rather than merely skip a cleanup.
 */
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import {
  isDeliveryIdle,
  registerDeliveryBarrier,
  type WorkflowOrchestratorContext,
} from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
  '01K11TFZ62YS0YYFDQ3E8B9YCZ',
];

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  // Real-session parity: the log-order-draws quiescence fixpoint keys its
  // progress metric on `mintCount`; without it the loop degrades to a single
  // turn and this suite would only exercise a degraded variant.
  let mintCount = 0;
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () =>
        ctxRef.current ? isDeliveryIdle(ctxRef.current) : true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}.`
          )
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => {
      mintCount += 1;
      return ulid(workflowStartedAt);
    },
    get mintCount() {
      return mintCount;
    },
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: () => {},
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

function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
  return [...ctx.invocationsQueue.values()]
    .filter((item) => item.type === 'step')
    .map((item) => (item.type === 'step' ? item.stepName : ''));
}

const resumeAtA = new Date('2026-07-27T12:00:05.000Z');
const resumeAtB = new Date('2026-07-27T12:00:06.000Z');

describe('barrier safety-net dispenser', () => {
  it('rejects a second barrier owner for the same event index', () => {
    const ctx = setupWorkflowContext([]);
    const barrier = registerDeliveryBarrier(ctx, 0, 'hook', { armed: false });

    expect(() => registerDeliveryBarrier(ctx, 0, 'step')).toThrowError(
      'Delivery barrier already registered at event index 0'
    );

    barrier.markDelivered();
    expect(isDeliveryIdle(ctx)).toBe(true);
  });

  it('suspends only after deliveries parked behind an unclaimed payload have run', async () => {
    const ops: Promise<any>[] = [];
    const payload = await dehydrateStepReturnValue(
      { poke: 1 },
      'wrun_test',
      undefined,
      ops
    );
    // Draw order in the body: c0 = the never-read hook, c1 = the sleep. The
    // poke payload is consumed before the wait completion, so the wait's
    // delivery gates on the unclaimed payload's barrier, which only the
    // dispenser retires. afterSleep must still be drawn (and become the
    // suspension's pending step) BEFORE the pass is allowed to suspend.
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'hook_created',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { token: 'dispenser-token', isWebhook: false },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { payload },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtA },
        createdAt: new Date(),
      },
    ] as unknown as Event[];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);
    const createHook = createCreateHook(ctx);
    const body = async () => {
      const afterSleep = useStep('afterSleep');
      createHook({ token: 'dispenser-token' });
      await sleep(resumeAtA);
      await afterSleep();
    };

    const { error } = await runWithDiscontinuation(ctx, body);
    expect(error).toBeDefined();
    if (!WorkflowSuspension.is(error)) {
      throw error;
    }
    // The wait delivered (despite parking behind the unclaimed payload) and
    // the branch ran to its next draw before the suspension was raised.
    expect(pendingStepNames(ctx)).toEqual(['afterSleep']);
  });

  it('wakes chains parked behind SEVERAL unclaimed payloads in log order', async () => {
    const ops: Promise<any>[] = [];
    const payload = await dehydrateStepReturnValue(
      { poke: 1 },
      'wrun_test',
      undefined,
      ops
    );
    // Two parked segments: waitA parks behind the first payload, waitB
    // behind both. The branches draw afterA / afterB when woken, and the
    // ULIDs they draw are position-determined only if A wakes before B —
    // lowest-first retirement with re-blocking. Under the per-barrier polls
    // this order was scheduling noise.
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'hook_created',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { token: 'dispenser-token', isWebhook: false },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: `wait_${CORR_IDS[2]}`,
        eventData: { resumeAt: resumeAtB },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { payload },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_4',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: `wait_${CORR_IDS[1]}`,
        eventData: { resumeAt: resumeAtA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_5',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { payload },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_6',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: `wait_${CORR_IDS[2]}`,
        eventData: { resumeAt: resumeAtB },
        createdAt: new Date(),
      },
    ] as unknown as Event[];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);
    const createHook = createCreateHook(ctx);
    const body = async () => {
      const afterA = useStep('afterA');
      const afterB = useStep('afterB');
      createHook({ token: 'dispenser-token' });
      await Promise.all([
        (async () => {
          await sleep(resumeAtA);
          await afterA();
        })(),
        (async () => {
          await sleep(resumeAtB);
          await afterB();
        })(),
      ]);
    };

    const { error } = await runWithDiscontinuation(ctx, body);
    expect(error).toBeDefined();
    if (!WorkflowSuspension.is(error)) {
      throw error;
    }
    const pending = [...ctx.invocationsQueue.values()].filter(
      (item) => item.type === 'step'
    );
    expect(pending.map((item) => item.stepName).sort()).toEqual([
      'afterA',
      'afterB',
    ]);
    // Log order: waitA completed at evnt_4, waitB at evnt_6, so branch A
    // draws first and afterA's correlation id sorts below afterB's.
    const idOf = (name: string) =>
      pending.find((item) => item.stepName === name)?.correlationId ?? '';
    expect(idOf('afterA') < idOf('afterB')).toBe(true);
  });

  it('drains the registry even when the promiseQueue is rejected', async () => {
    const ctx = setupWorkflowContext([]);
    // One unclaimed-payload barrier that only the dispenser can retire, with
    // retirement initially blocked so the dispenser has to go through its
    // promiseQueue re-arm path — against a queue that is already rejected.
    ctx.pendingDeliveries = 1;
    const rejected = Promise.reject(new Error('poisoned queue'));
    rejected.catch(() => {});
    ctx.promiseQueue = rejected as Promise<void>;
    const barrier = registerDeliveryBarrier(ctx, 0, 'hook', { armed: false });
    void barrier; // retired by the dispenser, never marked delivered
    expect(isDeliveryIdle(ctx)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Still parked: retirement is blocked by the in-flight delivery.
    expect(ctx.pendingDeliveryBarriers?.size).toBe(1);
    ctx.pendingDeliveries = 0;
    // The dispenser must come back from the rejected-queue backoff, retire
    // the entry, and restore delivery idle so a suspension could fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ctx.pendingDeliveryBarriers?.size).toBe(0);
    expect(isDeliveryIdle(ctx)).toBe(true);
  });
});
