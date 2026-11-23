import { RateLimitMaxWaitError, ReplayDivergenceError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type Event,
  MAX_RATE_WAIT_MS,
  SPEC_VERSION_RATE_LIMITS,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import { createSeededNanoid } from '../seeded-nanoid.js';
import { createContext } from '../vm/index.js';
import { createRateLimit } from './rate-limit.js';

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    // ctx.onWorkflowError is accessed via closure — it's defined below on the same object
    eventsConsumer: new EventsConsumer(events, {
      // Fake context: no deliveries are modeled, so the gate is a no-op here.
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(
            `Replay could not consume event: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}.`,
            { eventId: event.eventId }
          )
        );
      },
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: createSeededNanoid(() => context.globalThis.Math.random()),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  return ctx;
}

// The first correlation id the context above draws.
const CID = 'rate_01K11TFZ62YS0YYFDQ3E8B9YCV';
const CALL = { key: 'openai', limit: 60, period: '1m' } as const;
const EVENT_DATA = {
  key: 'openai',
  limit: 60,
  periodMs: 60_000,
  expiresAt: new Date('2026-01-01T00:00:00.000Z'),
};

function event(
  eventType: 'rate_created' | 'rate_acquired' | 'rate_failed',
  eventData: Record<string, unknown>,
  index = 0
): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_123',
    eventType,
    correlationId: CID,
    eventData,
    createdAt: new Date(),
  } as Event;
}

function rateLimitFor(events: Event[]) {
  const ctx = setupWorkflowContext(events);
  const errorReceived = withResolvers<Error>();
  ctx.onWorkflowError = errorReceived.resolve;
  return {
    ctx,
    errorReceived,
    rateLimit: createRateLimit(ctx, SPEC_VERSION_RATE_LIMITS),
  };
}

describe('createRateLimit', () => {
  it('refuses a run below the single orchestrator, before drawing an id', async () => {
    const ctx = setupWorkflowContext([]);
    const rateLimit = createRateLimit(
      ctx,
      SPEC_VERSION_SINGLE_ORCHESTRATOR - 1
    );
    await expect(rateLimit(CALL)).rejects.toThrow(/spec version 10/);
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('queues the call on a spec 9 run, for the World to refuse or allow', async () => {
    // The World may raise the run to spec 10 when its run_started is written,
    // which this delivery may not have seen yet; it refuses a rate event on a
    // run stamped below 10.
    const ctx = setupWorkflowContext([]);
    const rateLimit = createRateLimit(ctx, SPEC_VERSION_SINGLE_ORCHESTRATOR);
    void rateLimit(CALL);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.invocationsQueue.get(CID)).toMatchObject({ type: 'rate' });
  });

  it.each([
    [{ ...CALL, key: '' }, /non-empty/],
    [{ ...CALL, limit: 0 }, /positive integer/],
    [{ ...CALL, period: 'soon' }, /invalid period/],
    [{ ...CALL, period: '2d' }, /24 hours/],
    [{ ...CALL, maxWait: -1 }, /invalid maxWait/],
    [{ ...CALL, burst: 'yes' }, /burst must be a whole number/],
    [{ ...CALL, burst: true }, /burst must be a whole number/],
    [{ ...CALL, burst: 0 }, /burst must be a whole number/],
    [{ ...CALL, burst: 2.5 }, /burst must be a whole number/],
    [{ ...CALL, burst: 86_402 }, /more than 24 hours/],
    [{ ...CALL, key: 'k'.repeat(513) }, /513 bytes/],
    [{ ...CALL, key: '$sdk.internal' }, /reserved prefix/],
    [
      { ...CALL, key: '$sdk.internal', allowReservedKey: false },
      /reserved prefix/,
    ],
    [{ ...CALL, allowReservedKey: 'yes' }, /allowReservedKey must be/],
  ])('refuses %o', async (options, message) => {
    const { rateLimit, ctx } = rateLimitFor([]);
    await expect(rateLimit(options as never)).rejects.toThrow(message);
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('queues the call and suspends when the log holds nothing for it', async () => {
    const { rateLimit, ctx, errorReceived } = rateLimitFor([]);
    void rateLimit({ ...CALL, maxWait: '30s' });
    expect(await errorReceived.promise).toBeInstanceOf(WorkflowSuspension);
    const item = ctx.invocationsQueue.get(CID);
    expect(item).toMatchObject({
      type: 'rate',
      key: 'openai',
      limit: 60,
      periodMs: 60_000,
    });
    // The deadline is the workflow's clock plus the maxWait.
    if (item?.type !== 'rate') throw new Error('not a rate item');
    expect(item.expiresAt.getTime()).toBe(ctx.globalThis.Date.now() + 30_000);
    expect(item.hasCreatedEvent).toBeUndefined();
  });

  it('sends the opt-in for a reserved key, and nothing without it', async () => {
    const reserved = rateLimitFor([]);
    void reserved.rateLimit({
      ...CALL,
      key: '$sdk.internal',
      allowReservedKey: true,
    });
    await reserved.errorReceived.promise;
    expect(reserved.ctx.invocationsQueue.get(CID)).toMatchObject({
      key: '$sdk.internal',
      allowReservedKey: true,
    });

    const plain = rateLimitFor([]);
    void plain.rateLimit({ ...CALL, allowReservedKey: true });
    await plain.errorReceived.promise;
    // Allowed for any key, sent whenever it is set.
    expect(plain.ctx.invocationsQueue.get(CID)).toMatchObject({
      allowReservedKey: true,
    });
    const none = rateLimitFor([]);
    void none.rateLimit(CALL);
    await none.errorReceived.promise;
    expect(none.ctx.invocationsQueue.get(CID)).not.toHaveProperty(
      'allowReservedKey'
    );
  });

  it('sends the burst it asks for, and nothing for no burst', async () => {
    for (const burst of [60, 20, 2, 600]) {
      const bursting = rateLimitFor([]);
      void bursting.rateLimit({ ...CALL, burst });
      await bursting.errorReceived.promise;
      expect(bursting.ctx.invocationsQueue.get(CID)).toMatchObject({ burst });
    }

    // Absent, and a burst of one, are both no burst.
    for (const options of [CALL, { ...CALL, burst: 1 }]) {
      const plain = rateLimitFor([]);
      void plain.rateLimit(options);
      await plain.errorReceived.promise;
      expect(plain.ctx.invocationsQueue.get(CID)).not.toHaveProperty('burst');
    }
  });

  it('waits up to 30 days without a maxWait, and no longer with one', async () => {
    const { rateLimit, ctx, errorReceived } = rateLimitFor([]);
    void rateLimit(CALL);
    await errorReceived.promise;
    const item = ctx.invocationsQueue.get(CID);
    if (item?.type !== 'rate') throw new Error('not a rate item');
    expect(item.expiresAt.getTime()).toBe(
      ctx.globalThis.Date.now() + MAX_RATE_WAIT_MS
    );

    const long = rateLimitFor([]);
    void long.rateLimit({ ...CALL, maxWait: '90d' });
    await long.errorReceived.promise;
    const capped = long.ctx.invocationsQueue.get(CID);
    if (capped?.type !== 'rate') throw new Error('not a rate item');
    expect(capped.expiresAt.getTime()).toBe(
      long.ctx.globalThis.Date.now() + MAX_RATE_WAIT_MS
    );
  });

  it('resolves on a rate_acquired the World committed in place of the rate_created', async () => {
    const { rateLimit, ctx } = rateLimitFor([
      event('rate_acquired', { ...EVENT_DATA, acquireAt: new Date() }),
    ]);
    await expect(rateLimit(CALL)).resolves.toBeUndefined();
    expect(ctx.invocationsQueue.has(CID)).toBe(false);
  });

  it('waits on a rate_created with acquireAt, and resolves on its rate_acquired', async () => {
    const { rateLimit, ctx } = rateLimitFor([
      event('rate_created', { ...EVENT_DATA, acquireAt: new Date() }, 0),
      event('rate_acquired', { ...EVENT_DATA, createdSlot: 1 }, 1),
    ]);
    await expect(rateLimit(CALL)).resolves.toBeUndefined();
    expect(ctx.invocationsQueue.has(CID)).toBe(false);
  });

  it('marks the call created and suspends while it waits', async () => {
    const { rateLimit, ctx, errorReceived } = rateLimitFor([
      event('rate_created', { ...EVENT_DATA, acquireAt: new Date() }),
    ]);
    void rateLimit(CALL);
    expect(await errorReceived.promise).toBeInstanceOf(WorkflowSuspension);
    const item = ctx.invocationsQueue.get(CID);
    expect(item?.type === 'rate' && item.hasCreatedEvent).toBe(true);
  });

  it('rejects with RateLimitMaxWaitError on rate_failed', async () => {
    const wouldAcquireAt = new Date('2026-01-01T00:05:00.000Z');
    const { rateLimit, ctx } = rateLimitFor([
      event('rate_failed', {
        ...EVENT_DATA,
        reason: 'max_wait',
        acquireAt: wouldAcquireAt,
      }),
    ]);
    const error = await rateLimit(CALL).catch((e: unknown) => e);
    expect(RateLimitMaxWaitError.is(error)).toBe(true);
    expect(error).toMatchObject({ key: 'openai', wouldAcquireAt });
    expect(ctx.invocationsQueue.has(CID)).toBe(false);
  });

  it('reports divergence when the logged call is for another key', async () => {
    const { rateLimit, errorReceived } = rateLimitFor([
      event('rate_acquired', { ...EVENT_DATA, key: 'anthropic' }),
    ]);
    void rateLimit(CALL);
    const error = await errorReceived.promise;
    expect(error).toBeInstanceOf(ReplayDivergenceError);
    expect(error.message).toContain('"anthropic"');
  });

  it('reports divergence on an event of another kind under its id', async () => {
    const { rateLimit, errorReceived } = rateLimitFor([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: CID,
        createdAt: new Date(),
      } as Event,
    ]);
    void rateLimit(CALL);
    const error = await errorReceived.promise;
    expect(error).toBeInstanceOf(ReplayDivergenceError);
    expect(error.message).toContain('"wait_completed"');
  });
});
