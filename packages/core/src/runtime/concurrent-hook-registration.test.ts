import {
  EntityConflictError,
  PreconditionFailedError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventResult,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { type QueueItem, WorkflowSuspension } from '../global.js';
import { hydrateStepArguments } from '../serialization.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import { handleSuspension } from './suspension-handler.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

const run = {
  runId: 'wrun_concurrent_hooks',
  workflowName: 'test-workflow',
  status: 'running',
  specVersion: 6,
  input: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: new Date(),
  deploymentId: 'test-deployment',
} satisfies WorkflowRun;

function setup(count = 2) {
  const seed = [1, 2, 3].map(
    (slot) =>
      ({
        eventId: slotToEventId(slot),
        runId: run.runId,
        eventType: 'run_started',
        createdAt: new Date(),
      }) as Event
  );
  const eventLog = { events: [...seed], cursor: `eid:${seed[2].eventId}` };
  const pending = new Map<string, QueueItem>(
    Array.from({ length: count }, (_, i) => [
      `hook_${i}`,
      {
        type: 'hook',
        correlationId: `hook_${i}`,
        token: `customer:${i}`,
        hasConflictAwaiter: true,
      },
    ])
  );
  let slot = 3;
  const answer = (data: CreateEventRequest): EventResult => {
    const event = {
      ...data,
      eventId: slotToEventId(++slot),
      runId: run.runId,
      createdAt: new Date(),
    } as Event;
    return { event, eventCursor: `eid:${event.eventId}` };
  };
  const create = vi.fn(
    async (
      _runId: string,
      data: CreateEventRequest,
      _params?: CreateEventParams
    ) => answer(data)
  );
  const world = {
    events: { create, list: vi.fn() },
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as unknown as World;
  const invoke = (
    options: Partial<Parameters<typeof handleSuspension>[0]> = {}
  ) =>
    handleSuspension({
      world,
      run,
      eventLog,
      requestId: 'request',
      suspension: new WorkflowSuspension(pending, globalThis),
      ...options,
    });
  return { create, answer, world, seed, eventLog, pending, invoke };
}

describe('concurrent hook history reconciliation', () => {
  it.each([
    6, 7,
  ])('uses existing parallel writes and no catch-up hints on spec %s', async (specVersion) => {
    const t = setup();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    t.create.mockImplementation(async (_id, data) => {
      const result = t.answer(data);
      if (++active === 2) started.resolve();
      await release.promise;
      return result;
    });
    const invocation = t.invoke({ run: { ...run, specVersion } });
    await started.promise;
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.eventLog.events).toEqual(t.seed);
    release.resolve();
    const result = await invocation;

    for (const call of t.create.mock.calls) {
      expect(call[2]).toEqual({ requestId: 'request', resolveData: 'all' });
    }
    expect(t.world.events.list).not.toHaveBeenCalled();
    expect(t.eventLog.events.map((event) => event.eventId)).toEqual(
      [1, 2, 3, 4, 5].map(slotToEventId)
    );
    expect(t.eventLog.cursor).toBe(`eid:${slotToEventId(5)}`);
    expect(result.eventLogCarriedForward).toBe(true);
    expect(result.awaitedHookCorrelationIds.sort()).toEqual([
      'hook_0',
      'hook_1',
    ]);
  });

  it('orders committed responses by history position, not response arrival', async () => {
    const t = setup();
    const secondReturned = Promise.withResolvers<void>();
    t.create.mockImplementation(async (_id, data) => {
      const result = t.answer(data);
      if (data.correlationId === 'hook_0') await secondReturned.promise;
      else secondReturned.resolve();
      return result;
    });
    expect((await t.invoke()).eventLogCarriedForward).toBe(true);
    expect(
      t.eventLog.events.slice(3).map((event) => event.correlationId)
    ).toEqual(['hook_0', 'hook_1']);
  });

  it('keeps tokens, metadata, retention, webhooks and internal flags generic', async () => {
    const t = setup(3);
    const retention = new Date(Date.now() + 60_000);
    Object.assign(t.pending.get('hook_0')!, {
      token: '',
      metadata: { order: 123 },
      tokenRetentionUntil: retention,
    });
    Object.assign(t.pending.get('hook_1')!, {
      isWebhook: true,
      metadata: ['webhook'],
    });
    Object.assign(t.pending.get('hook_2')!, {
      isSystem: true,
      token: 'internal:custom',
    });
    expect((await t.invoke()).eventLogCarriedForward).toBe(true);
    const events = ['hook_0', 'hook_1', 'hook_2'].map(
      (id) => t.eventLog.events.find((event) => event.correlationId === id)!
    );
    expect(events[0].eventData).toMatchObject({
      token: '',
      tokenRetentionUntil: retention,
    });
    expect(
      await hydrateStepArguments(
        (events[0] as any).eventData.metadata,
        run.runId,
        undefined,
        []
      )
    ).toEqual({ order: 123 });
    expect(events[1].eventData).toMatchObject({ isWebhook: true });
    expect(
      await hydrateStepArguments(
        (events[1] as any).eventData.metadata,
        run.runId,
        undefined,
        []
      )
    ).toEqual(['webhook']);
    expect(events[2].eventData).toMatchObject({
      token: 'internal:custom',
      isSystem: true,
    });
  });

  it('preserves a committed token conflict as part of the complete suffix', async () => {
    const t = setup();
    t.create.mockImplementation(async (_id, data) => {
      const result = t.answer(data);
      if (data.correlationId === 'hook_1') {
        result.event = {
          ...result.event!,
          eventType: 'hook_conflict',
          eventData: { token: 'customer:1', conflictingRunId: 'wrun_owner' },
        } as Event;
      }
      return result;
    });
    const result = await t.invoke();
    expect(result.eventLogCarriedForward).toBe(true);
    expect(result.hookConflictCorrelationIds).toEqual(['hook_1']);
    expect(t.eventLog.events.at(-1)?.eventType).toBe('hook_conflict');
  });

  it.each([
    'gap before',
    'gap between',
    'missing event',
    'missing cursor',
    'duplicate slot',
    'old event',
    'wrong run',
    'wrong correlation',
    'wrong token',
    'wrong type',
    'non-slot ID',
    'truncated page',
    'lazy metadata',
    'omitted metadata',
  ])('retains the reload path without changing the log: %s', async (mode) => {
    const t = setup();
    if (mode.includes('metadata'))
      Object.assign(t.pending.get('hook_1')!, { metadata: 'payload' });
    t.create.mockImplementation(async (_id, data) => {
      const result = t.answer(data);
      const event = result.event!;
      if (mode === 'gap before')
        event.eventId = slotToEventId(data.correlationId === 'hook_0' ? 5 : 6);
      if (data.correlationId === 'hook_1') {
        if (mode === 'gap between') event.eventId = slotToEventId(6);
        if (mode === 'missing event') delete result.event;
        if (mode === 'missing cursor') delete result.eventCursor;
        if (mode === 'duplicate slot') event.eventId = slotToEventId(4);
        if (mode === 'old event') event.eventId = slotToEventId(2);
        if (mode === 'wrong run') event.runId = 'wrun_other';
        if (mode === 'wrong correlation') event.correlationId = 'hook_other';
        if (mode === 'wrong token') (event as any).eventData.token = 'other';
        if (mode === 'wrong type') (event as any).eventType = 'hook_disposed';
        if (mode === 'non-slot ID')
          event.eventId = 'evnt_01JXYZ12345678901234567890';
        if (mode === 'truncated page')
          Object.assign(result, {
            events: [],
            cursor: 'truncated',
            hasMore: true,
          });
        if (mode === 'lazy metadata')
          (event as any).eventData.metadata = { ref: 'unresolved' };
        if (mode === 'omitted metadata')
          delete (event as any).eventData.metadata;
      }
      return result;
    });
    expect((await t.invoke()).eventLogCarriedForward).toBe(false);
    expect(t.eventLog.events).toEqual(t.seed);
    expect(t.eventLog.cursor).toBe(`eid:${slotToEventId(3)}`);
    expect(t.create).toHaveBeenCalledTimes(2);
  });

  it('does not hide an existing hole in the loaded prefix', async () => {
    const t = setup();
    t.eventLog.events.splice(1, 1);
    const before = [...t.eventLog.events];
    expect((await t.invoke()).eventLogCarriedForward).toBe(false);
    expect(t.eventLog.events).toEqual(before);
  });

  it('uses the World cursor without assuming its encoding', async () => {
    const t = setup();
    t.create.mockImplementation(async (_id, data) => ({
      ...t.answer(data),
      eventCursor: `opaque:${data.correlationId}`,
    }));
    expect((await t.invoke()).eventLogCarriedForward).toBe(true);
    expect(t.eventLog.cursor).toBe('opaque:hook_1');
  });

  it('keeps a reload after a duplicate registration with no returned event', async () => {
    const t = setup();
    t.create.mockImplementation(async (_id, data) => {
      if (data.correlationId === 'hook_1')
        throw new EntityConflictError('exists');
      return t.answer(data);
    });
    expect((await t.invoke()).eventLogCarriedForward).toBe(false);
    expect(t.eventLog.events).toEqual(t.seed);
  });

  it('settles siblings before propagating a stale-write failure, without fallback writes', async () => {
    const t = setup();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stale = new PreconditionFailedError('stale');
    t.create.mockImplementation(async (_id, data) => {
      if (data.correlationId === 'hook_0') throw stale;
      started.resolve();
      await release.promise;
      return t.answer(data);
    });
    let settled = false;
    const invocation = t.invoke().finally(() => {
      settled = true;
    });
    const rejection = expect(invocation).rejects.toBe(stale);
    await started.promise;
    expect(settled).toBe(false);
    release.resolve();
    await rejection;
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.eventLog.events).toEqual(t.seed);
  });

  it('does not retry an ambiguous transport failure alongside a committed sibling', async () => {
    const t = setup();
    const error = new WorkflowWorldError('connection lost', {
      code: 'TRANSPORT',
    });
    t.create.mockImplementation(async (_id, data) => {
      if (data.correlationId === 'hook_1') throw error;
      return t.answer(data);
    });
    await expect(t.invoke()).rejects.toBe(error);
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.eventLog.events).toEqual(t.seed);
  });

  it('preserves one-shot replay recovery telemetry on individual requests', async () => {
    const t = setup();
    const reporter = new ReplayRecoveryReporter(2);
    reporter.activate();
    await t.invoke({ replayRecoveryReporter: reporter });
    expect(
      t.create.mock.calls.filter((call) => call[2]?.replayDivergenceCount === 2)
    ).toHaveLength(1);
  });

  it('keeps a reload when another suspension operation writes', async () => {
    const t = setup();
    t.pending.set('wait_1', {
      type: 'wait',
      correlationId: 'wait_1',
      resumeAt: new Date(Date.now() + 60_000),
    });
    expect((await t.invoke()).eventLogCarriedForward).toBe(false);
    const waitCall = t.create.mock.calls.find(
      (call) => call[1].eventType === 'wait_created'
    );
    expect(waitCall?.[2]?.eventCount).toBe(3);
    expect(t.eventLog.events).toEqual(t.seed);
  });

  it.each([
    'legacy run',
    'no log',
    'empty log',
    'same token',
    'force',
    'disposed',
    'aborted',
  ])('preserves the existing registration path for %s', async (mode) => {
    const t = setup();
    const options: Partial<Parameters<typeof handleSuspension>[0]> = {};
    if (mode === 'legacy run') options.run = { ...run, specVersion: 5 };
    if (mode === 'no log') options.eventLog = undefined;
    if (mode === 'empty log') options.eventLog = { events: [], cursor: null };
    if (mode === 'same token')
      Object.assign(t.pending.get('hook_1')!, { token: 'customer:0' });
    if (mode === 'force')
      Object.assign(t.pending.get('hook_1')!, { force: true });
    if (mode === 'disposed')
      Object.assign(t.pending.get('hook_1')!, { disposed: true });
    if (mode === 'aborted') {
      Object.assign(t.pending.get('hook_1')!, { abortRequested: true });
      t.world.streams = { write: vi.fn(), close: vi.fn() } as any;
    }
    expect((await t.invoke(options)).eventLogCarriedForward).toBe(false);
    for (const call of t.create.mock.calls.filter(
      (call) => call[1].eventType === 'hook_created'
    )) {
      expect(call[2]?.resolveData).toBeUndefined();
    }
  });
});
