/**
 * The backend-inversion mechanism, reproduced entirely inside core.
 *
 * A World that mints event IDs client-side (ULID) but reads them back with
 * `ORDER BY id` + `WHERE id > cursor` can commit an event whose ID sorts BELOW
 * a cursor a reader has already passed. Measured on the postgres world:
 * `step_created` commits an average of 32ms (max 319ms) after its ULID time and
 * `step_completed` 300ms (max 936ms), so a smaller-ULID event landing behind a
 * live reader's cursor is routine, not hypothetical.
 *
 * `packages/core` has no defence here and no way to notice. Its only watermark
 * is the opaque World cursor threaded through `loadWorkflowRunEvents`
 * (`runtime/helpers.ts:528-635`) and stored as `eventsCursor`; every incremental
 * load asks for events strictly after it (`runtime.ts:1280-1293`), as does the
 * inline-delta fast path (`runtime.ts:1252-1268`, contract at
 * `packages/world/src/events.ts` `CreateEventParams.sinceCursor`). A
 * below-watermark event is therefore not "unconsumed" — `EventsConsumer` never
 * sees it — and there is no count, sequence number or monotonicity assertion
 * anywhere in core that could flag its absence.
 *
 * These three tests are CHARACTERIZATION tests: unlike
 * `delivery-barrier-idle-collapse.test.ts` and
 * `buffered-hook-claim-ordering.test.ts`, they PASS on `main`. That is the
 * point. The engine behaves correctly on each input it is given; the corruption
 * comes from one invocation writing a follow-up `step_created` derived from a
 * wake order that the committed log does not record. No delivery-barrier work
 * can repair it, because the resulting log is one that NO invocation observed:
 * `awaitEarlierDeliveries` reconciles delivery order within a single view, and
 * here the two views differ by an event.
 *
 * The same shape is what makes the measured replay-vs-replay pairs harmful
 * (`step_created` blocked by another invocation's `step_started`): two
 * concurrent invocations of one run each hold a different view, and nothing in
 * core serializes their writes (`WORKFLOW_SEQUENTIAL_REPLAYS` is opt-in and off
 * by default — see the note at `runtime.ts:2197-2210`).
 */
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
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';

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

function deterministicUlids(count: number): string[] {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return Array.from({ length: count }, () => ulid(workflowStartedAt));
}

const ULIDS = deterministicUlids(4);

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
 * `Promise.all` starts the A branch first, so `stepA()` draws ULIDS[0] and
 * `stepB()` ULIDS[1]. Both park. Whichever completion is DELIVERED first
 * resumes its branch, which immediately calls its follow-up step and draws
 * ULIDS[2] — the single contended ID.
 */
function workflowBody(ctx: WorkflowOrchestratorContext) {
  const useStep = createUseStep(ctx);

  return async () => {
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');
    const afterA = useStep('afterA');
    const afterB = useStep('afterB');

    await Promise.all([
      (async () => {
        await stepA();
        await afterA();
      })(),
      (async () => {
        await stepB();
        await afterB();
      })(),
    ]);
  };
}

/**
 * The log as the backend finally orders it. `step_completed` for stepA sorts
 * before stepB's — its ULID is smaller — but it COMMITTED later, after a live
 * reader had already paged past it.
 */
async function canonicalLog(): Promise<Event[]> {
  const ops: Promise<unknown>[] = [];
  const [resultA, resultB] = await Promise.all([
    dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
    dehydrateStepReturnValue('b', 'wrun_test', undefined, ops),
  ]);

  return [
    event('evnt_0', 'step_created', `step_${ULIDS[0]}`, { stepName: 'stepA' }),
    event('evnt_1', 'step_created', `step_${ULIDS[1]}`, { stepName: 'stepB' }),
    event('evnt_2', 'step_started', `step_${ULIDS[0]}`, { stepName: 'stepA' }),
    event('evnt_3', 'step_started', `step_${ULIDS[1]}`, { stepName: 'stepB' }),
    // Below-watermark event: smaller ULID than evnt_5, committed after it.
    event('evnt_4', 'step_completed', `step_${ULIDS[0]}`, {
      stepName: 'stepA',
      result: resultA,
    }),
    event('evnt_5', 'step_completed', `step_${ULIDS[1]}`, {
      stepName: 'stepB',
      result: resultB,
    }),
  ];
}

/**
 * What the invocation that wrote the next `step_created` actually read: the
 * canonical log minus the below-watermark event. Its cursor was already past
 * `evnt_4`'s position when `evnt_4` committed, so no `events.list(cursor)`,
 * inline delta, or `withPreconditionRetry` reload can ever return it — they all
 * ask for events strictly after the cursor.
 */
function staleView(canonical: Event[]): Event[] {
  return canonical.filter((e) => e.eventId !== 'evnt_4');
}

function boundStepName(
  ctx: WorkflowOrchestratorContext,
  ulid: string
): string | undefined {
  const item = ctx.invocationsQueue.get(`step_${ulid}`);
  return item?.type === 'step' ? item.stepName : undefined;
}

describe('an event committed below the reader watermark', () => {
  it('binds the contended ULID to afterA in the canonical order', async () => {
    const events = await canonicalLog();
    const ctx = setupWorkflowContext(events);

    const error = await replay(ctx, workflowBody(ctx));

    expect(WorkflowSuspension.is(error)).toBe(true);
    // stepA's completion is first in the log, so its branch wakes first and
    // takes ULIDS[2]. This is the binding the log commits the runtime to.
    expect(boundStepName(ctx, ULIDS[2])).toBe('afterA');
  });

  it('binds the same ULID to afterB when that event is missing from the view', async () => {
    const events = staleView(await canonicalLog());
    const ctx = setupWorkflowContext(events);

    const error = await replay(ctx, workflowBody(ctx));

    expect(WorkflowSuspension.is(error)).toBe(true);
    // stepA never completes as far as this invocation can see, so the B branch
    // is the only one woken and it takes ULIDS[2]. Nothing here is wrong: the
    // engine is deterministic on the input it was handed. It then writes
    // `step_created(step_ULIDS[2], 'afterB')` into the shared log.
    expect(boundStepName(ctx, ULIDS[2])).toBe('afterB');
    expect(boundStepName(ctx, ULIDS[0])).toBe('stepA');
  });

  it('leaves a log that no replay can ever accept', async () => {
    const events = await canonicalLog();
    events.push(
      // The write the stale invocation made, now sitting in the canonical log
      // above the event it never saw.
      event('evnt_6', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'afterB',
      })
    );
    const ctx = setupWorkflowContext(events);

    const error = await replay(ctx, workflowBody(ctx));

    // Every subsequent invocation loads the full log, replays the canonical
    // order, binds ULIDS[2] to afterA, and rejects evnt_6. The recovery replays
    // at `runtime.ts:2635-2670` all re-read the same log, so all three diverge
    // at the same event id and the run ends as CORRUPTED_EVENT_LOG — which is
    // the production signature: a fixed divergence event id across retries.
    expect(ReplayDivergenceError.is(error)).toBe(true);
    expect((error as ReplayDivergenceError).message).toContain(
      `Replay divergence: step event step_created for step_${ULIDS[2]} belongs to "afterB", but the current step consumer is "afterA"`
    );
    expect((error as ReplayDivergenceError).eventId).toBe('evnt_6');
  });
});
