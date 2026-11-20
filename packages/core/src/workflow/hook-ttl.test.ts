import { HookExpiredError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import type { WaitInvocationQueueItem } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import { isHookExpiryWait } from '../runtime/runs.js';
import { createSeededNanoid } from '../seeded-nanoid.js';
import { dehydrateStepReturnValue } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { createCreateHook, resolveHookExpiry } from './hook.js';

// The first ULID `setupWorkflowContext` mints: the hook's id, and so (with
// the `hook_` prefix swapped for `wait_`) its expiry wait's.
const ULID = '01K11TFZ62YS0YYFDQ3E8B9YCV';
const HOOK_ID = `hook_${ULID}`;
const EXPIRY_ID = `wait_${ULID}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    worldCapabilities: {},
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () => true,
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: createSeededNanoid(() => context.globalThis.Math.random()),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    suspensionGeneration: 0,
  };
}

const resumeAt = new Date('2026-01-01T00:00:00.000Z');

function hookCreated(index: number): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType: 'hook_created',
    correlationId: HOOK_ID,
    eventData: { token: 'tok' },
    createdAt: new Date(),
  } as Event;
}
function expiryCreated(index: number): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType: 'wait_created',
    correlationId: EXPIRY_ID,
    eventData: { resumeAt, hookId: HOOK_ID },
    createdAt: new Date(),
  } as Event;
}
function expiryCompleted(index: number): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType: 'wait_completed',
    correlationId: EXPIRY_ID,
    eventData: { resumeAt },
    createdAt: new Date(),
  } as Event;
}
async function hookReceived(index: number, payload: unknown): Promise<Event> {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType: 'hook_received',
    correlationId: HOOK_ID,
    eventData: {
      token: 'tok',
      payload: await dehydrateStepReturnValue(
        payload,
        'wrun_test',
        undefined,
        []
      ),
    },
    createdAt: new Date(),
  } as Event;
}
function hookDisposed(index: number): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType: 'hook_disposed',
    correlationId: HOOK_ID,
    eventData: { token: 'tok' },
    createdAt: new Date(),
  } as Event;
}

describe('resolveHookExpiry', () => {
  it('defaults to 30 days', () => {
    const before = Date.now();
    const expiresAt = resolveHookExpiry(undefined);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt!.getTime() - before).toBeGreaterThanOrEqual(30 * DAY_MS);
    expect(expiresAt!.getTime() - before).toBeLessThan(30 * DAY_MS + 60_000);
  });

  it('never expires for an explicit Infinity', () => {
    expect(resolveHookExpiry(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('accepts a duration string, milliseconds and a Date', () => {
    const before = Date.now();
    expect(resolveHookExpiry('1h')!.getTime() - before).toBeGreaterThanOrEqual(
      3_600_000
    );
    expect(resolveHookExpiry(5_000)!.getTime() - before).toBeGreaterThanOrEqual(
      5_000
    );
    expect(resolveHookExpiry(resumeAt)).toEqual(resumeAt);
  });

  it.each([-1, Number.NaN, Number.NEGATIVE_INFINITY])('rejects %s', (ttl) => {
    expect(() => resolveHookExpiry(ttl)).toThrow(/invalid `ttl`/);
  });
});

describe('createHook ttl', () => {
  it('queues an expiry wait tagged with the hook id, 30 days out by default', () => {
    const ctx = setupWorkflowContext([]);
    createCreateHook(ctx)({ token: 'tok' });
    const wait = ctx.invocationsQueue.get(EXPIRY_ID) as WaitInvocationQueueItem;
    expect(wait).toMatchObject({ type: 'wait', hookId: HOOK_ID });
    expect(wait.resumeAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MS);
    expect([...ctx.invocationsQueue.keys()]).toEqual([HOOK_ID, EXPIRY_ID]);
  });

  it('queues no expiry for ttl: Infinity', () => {
    const ctx = setupWorkflowContext([]);
    createCreateHook(ctx)({ token: 'tok', ttl: Number.POSITIVE_INFINITY });
    expect([...ctx.invocationsQueue.keys()]).toEqual([HOOK_ID]);
  });

  it('queues no expiry for an SDK-internal hook', () => {
    const ctx = setupWorkflowContext([]);
    createCreateHook(ctx)({ token: 'tok', isSystem: true } as never);
    expect([...ctx.invocationsQueue.keys()]).toEqual([HOOK_ID]);
  });

  it('drops an unrecorded expiry when the hook is disposed', () => {
    const ctx = setupWorkflowContext([]);
    const hook = createCreateHook(ctx)({ token: 'tok' });
    hook.dispose();
    expect([...ctx.invocationsQueue.keys()]).toEqual([HOOK_ID]);
  });

  it('rejects the pending await with HookExpiredError and queues the disposal', async () => {
    const ctx = setupWorkflowContext([
      hookCreated(0),
      expiryCreated(1),
      expiryCompleted(2),
    ]);
    const hook = createCreateHook(ctx)<{ n: number }>({ token: 'tok' });
    const error = await hook.then(
      () => undefined,
      (err: unknown) => err
    );
    expect(HookExpiredError.is(error)).toBe(true);
    expect(error).toMatchObject({ token: 'tok', expiredAt: resumeAt });
    // Every later await rejects the same way.
    await expect(hook).rejects.toSatisfy((e) => HookExpiredError.is(e));
    // The expiry is done; the hook's disposal is what the next suspension
    // writes.
    expect(ctx.invocationsQueue.has(EXPIRY_ID)).toBe(false);
    expect(ctx.invocationsQueue.get(HOOK_ID)).toMatchObject({ disposed: true });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('ends a for-await loop with HookExpiredError after the payloads that came first', async () => {
    const ctx = setupWorkflowContext([
      hookCreated(0),
      expiryCreated(1),
      await hookReceived(2, { n: 1 }),
      await hookReceived(3, { n: 2 }),
      expiryCompleted(4),
    ]);
    const hook = createCreateHook(ctx)<{ n: number }>({ token: 'tok' });
    const seen: number[] = [];
    let thrown: unknown;
    try {
      for await (const payload of hook) seen.push(payload.n);
    } catch (err) {
      thrown = err;
    }
    expect(seen).toEqual([1, 2]);
    expect(HookExpiredError.is(thrown)).toBe(true);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('drops a payload that landed after the expiry, and consumes the disposal', async () => {
    const ctx = setupWorkflowContext([
      hookCreated(0),
      expiryCreated(1),
      expiryCompleted(2),
      await hookReceived(3, { n: 1 }),
      hookDisposed(4),
    ]);
    const onUnconsumedEvent = vi.fn();
    (ctx.eventsConsumer as any).onUnconsumedEvent = onUnconsumedEvent;
    const hook = createCreateHook(ctx)<{ n: number }>({ token: 'tok' });
    await expect(hook).rejects.toSatisfy((e) => HookExpiredError.is(e));
    await expect(hook).rejects.toSatisfy((e) => HookExpiredError.is(e));
    expect(ctx.invocationsQueue.size).toBe(0);
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('is a no-op when the hook was disposed first, and still consumes the expiry', async () => {
    const ctx = setupWorkflowContext([
      hookCreated(0),
      expiryCreated(1),
      await hookReceived(2, { n: 1 }),
      hookDisposed(3),
      expiryCompleted(4),
    ]);
    const onUnconsumedEvent = vi.fn();
    (ctx.eventsConsumer as any).onUnconsumedEvent = onUnconsumedEvent;
    const hook = createCreateHook(ctx)<{ n: number }>({ token: 'tok' });
    await expect(hook).resolves.toEqual({ n: 1 });
    hook.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.invocationsQueue.size).toBe(0);
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });
});

describe('isHookExpiryWait', () => {
  it('recognizes an expiry by its tag', () => {
    expect(isHookExpiryWait(expiryCreated(1), [])).toBe(true);
  });

  it('recognizes an untagged expiry by the ULID it shares with its hook', () => {
    const untagged = {
      ...expiryCreated(1),
      eventData: { resumeAt },
    } as Event;
    expect(isHookExpiryWait(untagged, [hookCreated(0), untagged])).toBe(true);
  });

  it('leaves a sleep alone', () => {
    const sleep = {
      ...expiryCreated(1),
      correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCW',
      eventData: { resumeAt },
    } as Event;
    expect(isHookExpiryWait(sleep, [hookCreated(0), sleep])).toBe(false);
  });
});
