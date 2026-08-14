/**
 * Companion to `step-delivery-ordering.test.ts`, which reproduces the two
 * production `CORRUPTED_EVENT_LOG` shapes. Those two logs happen to be consumed
 * by branches that reach their next `useStep` call in the fewest possible
 * microtask hops, so they cannot distinguish two very different guarantees:
 *
 *  a) step results are DELIVERED in event-log order relative to wait and hook
 *     deliveries, or
 *  b) a step result merely resolves a hop or two later than before, which is
 *     enough to lose a race against the shortest consumers and nothing more.
 *
 * The distinction is not academic. A branch resumed by a `wait_completed` or a
 * hook payload may need any number of further hops before it draws its next
 * ULID (`for await` over a hook resumes the generator, settles the promise from
 * `next()`, and only then runs the loop body; workflow code is free to await
 * anything in between). Under (b) a memo-warm step result overtakes such a
 * branch and reorders the ULID allocation exactly as the unfixed runtime did.
 *
 * So each case here replays a log that a live run legitimately produced — the
 * live invocation received the two events in SEPARATE deliveries, so the first
 * branch ran to completion long before the second event existed — while the
 * replay receives both in one drain window and must still allocate the ULIDs in
 * the recorded order. The consumer is padded with a varying number of extra
 * `await`s to make hop count the only variable.
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
import {
  dehydrateStepError,
  dehydrateStepReturnValue,
} from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

function setupWorkflowContext(
  events: Event[],
  replayPayloadCache: ReplayPayloadCache = new ReplayPayloadCache()
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
      // Fake context: no deliveries are modeled, so the gate is a no-op here.
      isDeliveryIdle: () => true,
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

const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
];

async function runWithDiscontinuation(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<any>
): Promise<{ result?: any; error?: any }> {
  const d = withResolvers<void>();
  ctx.onWorkflowError = d.reject;
  let result: any;
  let error: any;
  try {
    result = await Promise.race([workflowFn(), d.promise]);
  } catch (err) {
    error = err;
  }
  return { result, error };
}

function slowHydration() {
  return (async () => {
    const serialization = await import('./serialization.js');
    const original = serialization.hydrateStepReturnValue;
    return vi
      .spyOn(serialization, 'hydrateStepReturnValue')
      .mockImplementation(async (...args) => {
        await new Promise((r) => setTimeout(r, 10));
        return original(...args);
      });
  })();
}

async function buildEventLog(): Promise<Event[]> {
  const ops: Promise<any>[] = [];
  const [hookPayload, stepAResult] = await Promise.all([
    dehydrateStepReturnValue({ kind: 'ping' }, 'wrun_test', undefined, ops),
    dehydrateStepReturnValue('ok', 'wrun_test', undefined, ops),
  ]);
  return [
    {
      eventId: 'evnt_0',
      runId: 'wrun_test',
      eventType: 'hook_created',
      correlationId: `hook_${CORR_IDS[0]}`,
      eventData: { token: 'test-token', isWebhook: false },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_1',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[1]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_2',
      runId: 'wrun_test',
      eventType: 'step_started',
      correlationId: `step_${CORR_IDS[1]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_3',
      runId: 'wrun_test',
      eventType: 'hook_received',
      correlationId: `hook_${CORR_IDS[0]}`,
      eventData: { token: 'test-token', payload: hookPayload },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_4',
      runId: 'wrun_test',
      eventType: 'step_completed',
      correlationId: `step_${CORR_IDS[1]}`,
      eventData: { stepName: 'stepA', result: stepAResult },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_5',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[2]}`,
      eventData: { stepName: 'afterHook' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_6',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[3]}`,
      eventData: { stepName: 'afterStep' },
      createdAt: new Date(),
    },
  ];
}

function body(ctx: WorkflowOrchestratorContext, extraHops: number) {
  const useStep = createUseStep(ctx);
  const createHook = createCreateHook(ctx);
  return async () => {
    const stepA = useStep('stepA');
    const afterStep = useStep('afterStep');
    const afterHook = useStep('afterHook');
    const hook = createHook<{ kind: string }>({ token: 'test-token' });
    const b1 = (async () => {
      await stepA();
      await afterStep();
    })();
    const b2 = (async () => {
      for await (const p of hook) {
        void p;
        for (let i = 0; i < extraHops; i++) {
          await Promise.resolve();
        }
        await afterHook();
        break;
      }
    })();
    await Promise.all([b1, b2]);
  };
}

function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
  return [...ctx.invocationsQueue.values()]
    .filter((i) => i.type === 'step')
    .map((i) => (i.type === 'step' ? i.stepName : ''));
}

describe('step delivery ordering is independent of consumer hop count: hook payload', () => {
  for (const extraHops of [0, 1, 2, 4, 8, 16]) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra consumer hops`, async () => {
      const spy = await slowHydration();
      try {
        const events = await buildEventLog();
        const cache = new ReplayPayloadCache();
        const c1 = setupWorkflowContext(events, cache);
        const r1 = await runWithDiscontinuation(c1, body(c1, extraHops));
        if (!WorkflowSuspension.is(r1.error)) {
          throw r1.error ?? new Error('replay 1 did not suspend');
        }
        const c2 = setupWorkflowContext(events, cache);
        const r2 = await runWithDiscontinuation(c2, body(c2, extraHops));
        if (!WorkflowSuspension.is(r2.error)) {
          throw r2.error ?? new Error('replay 2 did not suspend');
        }
        expect(pendingStepNames(c2).sort()).toEqual(['afterHook', 'afterStep']);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

const RESUME_AT = new Date('2026-07-27T12:00:05.000Z');

async function buildWaitEventLog(): Promise<Event[]> {
  const ops: Promise<any>[] = [];
  const stepAResult = await dehydrateStepReturnValue(
    'ok',
    'wrun_test',
    undefined,
    ops
  );
  return [
    {
      eventId: 'evnt_0',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_1',
      runId: 'wrun_test',
      eventType: 'wait_created',
      correlationId: `wait_${CORR_IDS[1]}`,
      eventData: { resumeAt: RESUME_AT },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_2',
      runId: 'wrun_test',
      eventType: 'step_started',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_3',
      runId: 'wrun_test',
      eventType: 'wait_completed',
      correlationId: `wait_${CORR_IDS[1]}`,
      eventData: { resumeAt: RESUME_AT },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_4',
      runId: 'wrun_test',
      eventType: 'step_completed',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA', result: stepAResult },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_5',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[2]}`,
      eventData: { stepName: 'afterSleep' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_6',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[3]}`,
      eventData: { stepName: 'afterStep' },
      createdAt: new Date(),
    },
  ];
}

function waitBody(ctx: WorkflowOrchestratorContext, extraHops: number) {
  const useStep = createUseStep(ctx);
  const sleep = createSleep(ctx);
  return async () => {
    const stepA = useStep('stepA');
    const afterStep = useStep('afterStep');
    const afterSleep = useStep('afterSleep');
    const b1 = (async () => {
      await stepA();
      await afterStep();
    })();
    const b2 = (async () => {
      await sleep(RESUME_AT);
      for (let i = 0; i < extraHops; i++) {
        await Promise.resolve();
      }
      await afterSleep();
    })();
    await Promise.all([b1, b2]);
  };
}

describe('step delivery ordering is independent of consumer hop count: wait completion', () => {
  for (const extraHops of [0, 1, 2, 4, 8, 16]) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra consumer hops`, async () => {
      const spy = await slowHydration();
      try {
        const events = await buildWaitEventLog();
        const cache = new ReplayPayloadCache();
        const c1 = setupWorkflowContext(events, cache);
        const r1 = await runWithDiscontinuation(c1, waitBody(c1, extraHops));
        if (!WorkflowSuspension.is(r1.error))
          throw r1.error ?? new Error('replay 1 did not suspend');
        const c2 = setupWorkflowContext(events, cache);
        const r2 = await runWithDiscontinuation(c2, waitBody(c2, extraHops));
        if (!WorkflowSuspension.is(r2.error))
          throw r2.error ?? new Error('replay 2 did not suspend');
        expect(pendingStepNames(c2).sort()).toEqual([
          'afterSleep',
          'afterStep',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

/**
 * `step_failed` is as branch-deciding as `step_completed` — it decides whether
 * a `catch` continuation runs, and therefore which ULID the follow-up
 * `useStep` there draws — and it goes through the same barrier registration and
 * event-consumption-time deferral capture. Covered here so a refactor cannot
 * silently order rejections differently from results.
 */
async function buildFailedEventLog(): Promise<Event[]> {
  const ops: Promise<any>[] = [];
  const stepAError = await dehydrateStepError(
    new Error('stepA blew up'),
    'wrun_test',
    undefined,
    ops
  );
  return [
    {
      eventId: 'evnt_0',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_1',
      runId: 'wrun_test',
      eventType: 'wait_created',
      correlationId: `wait_${CORR_IDS[1]}`,
      eventData: { resumeAt: RESUME_AT },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_2',
      runId: 'wrun_test',
      eventType: 'step_started',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_3',
      runId: 'wrun_test',
      eventType: 'wait_completed',
      correlationId: `wait_${CORR_IDS[1]}`,
      eventData: { resumeAt: RESUME_AT },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_4',
      runId: 'wrun_test',
      eventType: 'step_failed',
      correlationId: `step_${CORR_IDS[0]}`,
      eventData: { stepName: 'stepA', error: stepAError },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_5',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[2]}`,
      eventData: { stepName: 'afterSleep' },
      createdAt: new Date(),
    },
    {
      eventId: 'evnt_6',
      runId: 'wrun_test',
      eventType: 'step_created',
      correlationId: `step_${CORR_IDS[3]}`,
      eventData: { stepName: 'afterFailure' },
      createdAt: new Date(),
    },
  ];
}

function failedBody(ctx: WorkflowOrchestratorContext, extraHops: number) {
  const useStep = createUseStep(ctx);
  const sleep = createSleep(ctx);
  return async () => {
    const stepA = useStep('stepA');
    const afterFailure = useStep('afterFailure');
    const afterSleep = useStep('afterSleep');
    const branchStep = (async () => {
      try {
        await stepA();
      } catch {
        await afterFailure();
      }
    })();
    const branchSleep = (async () => {
      await sleep(RESUME_AT);
      for (let i = 0; i < extraHops; i++) {
        await Promise.resolve();
      }
      await afterSleep();
    })();
    await Promise.all([branchStep, branchSleep]);
  };
}

describe('step delivery ordering is independent of consumer hop count: step failure', () => {
  for (const extraHops of [0, 1, 2, 4, 8, 16]) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra consumer hops`, async () => {
      const spy = await slowHydration();
      try {
        const events = await buildFailedEventLog();
        const cache = new ReplayPayloadCache();
        const c1 = setupWorkflowContext(events, cache);
        const r1 = await runWithDiscontinuation(c1, failedBody(c1, extraHops));
        if (!WorkflowSuspension.is(r1.error)) {
          throw r1.error ?? new Error('replay 1 did not suspend');
        }
        const c2 = setupWorkflowContext(events, cache);
        const r2 = await runWithDiscontinuation(c2, failedBody(c2, extraHops));
        if (!WorkflowSuspension.is(r2.error)) {
          throw r2.error ?? new Error('replay 2 did not suspend');
        }
        expect(pendingStepNames(c2).sort()).toEqual([
          'afterFailure',
          'afterSleep',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  }
});
