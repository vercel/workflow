/**
 * A fourth delivery-ordering hole, reached end to end through the real replay
 * machinery, and the one whose observable matches the production report most
 * closely: a LATER-in-log step result handed to workflow code before an
 * EARLIER-in-log buffered hook payload.
 *
 * Two rules interact. Both are deliberate; together they are not sound.
 *
 *  1. A step result SKIPS any earlier delivery that will not "resolve on its
 *     own" — `private.ts:368-371`, justified at `:336-344`. The motivating case
 *     is an unclaimed buffered hook payload: it is delivered only when the
 *     workflow next reads the hook, and reaching that read commonly requires
 *     the step result itself, so gating the step on it would stall the run
 *     until the idle safety net fires.
 *
 *  2. `resolvesOnItsOwn` is TRANSITIVE — `private.ts:296-319`. An armed wait or
 *     hook barrier reports false whenever an earlier barrier it defers behind
 *     reports false.
 *
 * So an unclaimed buffered hook payload at index i poisons every armed wait or
 * hook barrier after it: a `wait_completed` at index j > i defers behind the
 * buffered payload (`DEFER_BEHIND.wait` includes `'hook'`, and only `kind ===
 * 'step'` gets the skip), which makes `resolvesOnItsOwn(j)` false, which makes a
 * step result at index k > j skip index j as well — even though that wait is
 * armed, committed, and about to wake a branch.
 *
 * The step result then has an EMPTY deferral set. It resolves as soon as its
 * hydration slot ends, while the wait is still parked waiting for the idle net
 * to retire the buffered payload's barrier — several macrotasks away. The step's
 * branch draws its follow-up ULID first, the log says the hook branch drew it,
 * and replay dies with the production error:
 *
 *   Replay divergence: step event step_created for step_<ULID> belongs to
 *   "afterHook", but the current step consumer is "afterStep"
 *
 * The three existing suites miss this because none of them buffers a hook
 * payload: every hook case in `step-delivery-ordering.test.ts`,
 * `step-delivery-hop-count.test.ts` and `delivery-barrier-coverage.test.ts`
 * registers its awaiter before the drain starts, so it takes the ARMED
 * `promises.length > 0` path in `hook.ts:283-345` and never exercises
 * `claim()`'s claim-time deferral at `hook.ts:361-384`.
 *
 * Unlike the barrier-primitive tests in
 * `delivery-barrier-idle-collapse.test.ts`, this one needs no artificial
 * hydration latency and no manufactured idle window: it fails on `main` from
 * the event log alone.
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
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

const FIXED_TIMESTAMP = 1753481739458;
const RESUME_AT = new Date(FIXED_TIMESTAMP + 5_000);

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

/**
 * The log below is one a live run legitimately produces — the same two-writer
 * interleaving `delivery-barrier-coverage.test.ts` case 1 documents:
 *
 *   evnt_4  hook_received           ← arrived while the sleep branch slept, so
 *                                     the invocation that consumed it had no
 *                                     consumer for it and could not claim it
 *   evnt_5  wait_completed          ← the wait fired; that invocation woke the
 *                                     sleep branch, which read the hook,
 *                                     claimed the payload, and drew…
 *   evnt_6  step_completed stepA    ← …meanwhile stepA's worker appended this,
 *                                     after that invocation had loaded its log
 *   evnt_7  step_created afterHook  ← …ULID[3] here. It never saw evnt_6.
 *   evnt_8  step_created afterStep  ← a later invocation delivered stepA and
 *                                     drew ULID[4], exactly as the log orders
 *
 * On replay all three of evnt_4, evnt_5 and evnt_6 land in one drain window, so
 * the delivery-barrier registry is the only thing deciding which branch draws
 * ULID[3] — and it must decide the way the log records.
 */
async function buildEventLog(): Promise<Event[]> {
  const ops: Promise<unknown>[] = [];
  const [hookPayload, stepAResult] = await Promise.all([
    dehydrateStepReturnValue({ kind: 'ping' }, 'wrun_test', undefined, ops),
    dehydrateStepReturnValue('ok', 'wrun_test', undefined, ops),
  ]);

  return [
    event('evnt_0', 'hook_created', `hook_${ULIDS[0]}`, {
      token: 'tok',
      isWebhook: false,
    }),
    event('evnt_1', 'step_created', `step_${ULIDS[1]}`, { stepName: 'stepA' }),
    event('evnt_2', 'wait_created', `wait_${ULIDS[2]}`, {
      resumeAt: RESUME_AT,
    }),
    event('evnt_3', 'step_started', `step_${ULIDS[1]}`, { stepName: 'stepA' }),
    event('evnt_4', 'hook_received', `hook_${ULIDS[0]}`, {
      token: 'tok',
      payload: hookPayload,
    }),
    event('evnt_5', 'wait_completed', `wait_${ULIDS[2]}`, {
      resumeAt: RESUME_AT,
    }),
    event('evnt_6', 'step_completed', `step_${ULIDS[1]}`, {
      stepName: 'stepA',
      result: stepAResult,
    }),
    event('evnt_7', 'step_created', `step_${ULIDS[3]}`, {
      stepName: 'afterHook',
    }),
    event('evnt_8', 'step_created', `step_${ULIDS[4]}`, {
      stepName: 'afterStep',
    }),
  ];
}

/**
 * ULID draw order: `createHook()` takes ULIDS[0], `stepA()` ULIDS[1], `sleep()`
 * ULIDS[2]. Then whichever branch is woken FIRST takes ULIDS[3] — the log says
 * that is the hook branch.
 *
 * The step branch is padded with a varying number of extra `await`s, per the
 * lesson in `step-delivery-hop-count.test.ts`: a fix that only reorders the
 * `resolve()` calls, rather than making the step actually wait for the hook
 * delivery, would pass at 0 hops and fail as soon as the branch is padded.
 */
function workflowBody(ctx: WorkflowOrchestratorContext, extraHops: number) {
  const useStep = createUseStep(ctx);
  const createHook = createCreateHook(ctx);
  const sleep = createSleep(ctx);

  return async () => {
    const stepA = useStep('stepA');
    const afterStep = useStep('afterStep');
    const afterHook = useStep('afterHook');
    const hook = createHook<{ kind: string }>({ token: 'tok' });

    await Promise.all([
      (async () => {
        await stepA();
        for (let i = 0; i < extraHops; i++) {
          await Promise.resolve();
        }
        await afterStep();
      })(),
      (async () => {
        // The sleep is what makes `hook_received` BUFFERED on replay: this
        // branch is parked here, with no awaiter registered on the hook, when
        // the drain reaches evnt_4. The payload is therefore delivered by
        // `claim()` (`hook.ts:361-384`) rather than the armed path.
        await sleep('5s');
        for await (const payload of hook) {
          void payload;
          await afterHook();
          break;
        }
      })(),
    ]);
  };
}

function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
  return [...ctx.invocationsQueue.values()].flatMap((item) =>
    item.type === 'step' ? [item.stepName] : []
  );
}

describe('buffered hook payload vs. a later step result', () => {
  for (const extraHops of [0, 1, 2, 4, 8, 16]) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra step-branch hops`, async () => {
      const events = await buildEventLog();
      const ctx = setupWorkflowContext(events);

      const error = await replay(ctx, workflowBody(ctx, extraHops));

      // FAILS on `main` with the production error shape: the step result at
      // evnt_6 skipped evnt_4 (unclaimed buffered payload) AND evnt_5 (armed
      // wait, but transitively non-self-resolving because it defers behind
      // evnt_4), so its deferral set was empty. It resolved on microtasks while
      // the wait was still parked, and the step branch drew ULIDS[3] — the ULID
      // the log assigns to `afterHook`.
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
      expect(pendingStepNames(ctx)).toEqual(['afterHook', 'afterStep']);
      expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
    });
  }
});
