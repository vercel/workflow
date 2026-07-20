import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { importKey } from './encryption.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  dehydrateStepReturnValue,
  deserializePreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

function makeRun(input: unknown): WorkflowRun {
  const now = new Date();
  return {
    runId: 'wrun_cache_test',
    status: 'running',
    deploymentId: 'dpl_test',
    workflowName: 'workflow//test//cache',
    input,
    attributes: {},
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeEvents(payloads: unknown[]): Event[] {
  const createdAt = new Date();
  return [
    {
      runId: 'wrun_cache_test',
      eventId: 'evnt_result',
      eventType: 'step_completed',
      correlationId: 'step_result',
      eventData: { result: payloads[0] },
      createdAt,
    },
    {
      runId: 'wrun_cache_test',
      eventId: 'evnt_error',
      eventType: 'step_failed',
      correlationId: 'step_error',
      eventData: { error: payloads[1] },
      createdAt,
    },
    {
      runId: 'wrun_cache_test',
      eventId: 'evnt_hook',
      eventType: 'hook_received',
      correlationId: 'hook_payload',
      eventData: { payload: payloads[2] },
      createdAt,
    },
  ];
}

describe('ReplayPayloadCache', () => {
  it('deduplicates preparation and accepts a synchronous preparer', async () => {
    const payload = new Uint8Array([1]);
    const preparer = vi.fn<ReplayPayloadPreparer>((value) => ({ data: value }));
    const cache = new ReplayPayloadCache(undefined, preparer);

    const first = cache.prepareEventPayload('evnt_one', 'result', payload);
    const second = cache.prepareEventPayload('evnt_one', 'result', payload);

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ data: payload });
    expect(preparer).toHaveBeenCalledOnce();
  });

  it('keeps a failed prewarm until its consumer observes it, then retries', async () => {
    const payload = new Uint8Array([1]);
    const run = makeRun(payload);
    const preparer = vi
      .fn<ReplayPayloadPreparer>()
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockReturnValueOnce({ data: payload });
    const cache = new ReplayPayloadCache(undefined, preparer);

    await cache.prewarm(run, []);
    await expect(cache.prepareWorkflowInput(run)).rejects.toThrow(
      'decrypt failed'
    );
    expect(preparer).toHaveBeenCalledOnce();

    await expect(cache.prepareWorkflowInput(run)).resolves.toEqual({
      data: payload,
    });
    expect(preparer).toHaveBeenCalledTimes(2);
  });

  it('prewarms workflow, step, error, and hook payloads concurrently', async () => {
    const payloads = [0, 1, 2, 3].map((value) => new Uint8Array([value]));
    const resolvers: Array<() => void> = [];
    const preparer = vi.fn<ReplayPayloadPreparer>(
      (value) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ data: value }));
        })
    );
    const cache = new ReplayPayloadCache(undefined, preparer);
    const run = makeRun(payloads[0]);
    const events = makeEvents(payloads.slice(1));

    const warming = cache.prewarm(run, events);
    expect(preparer).toHaveBeenCalledTimes(4);
    for (const resolve of resolvers.reverse()) resolve();
    await warming;

    const allSettled = vi.spyOn(Promise, 'allSettled');
    await cache.prewarm(run, events);
    expect(preparer).toHaveBeenCalledTimes(4);
    expect(allSettled).toHaveBeenLastCalledWith([]);
    allSettled.mockRestore();
  });

  it('caches real decrypt/decompress output but revives fresh objects', async () => {
    const key = await importKey(new Uint8Array(32).fill(7));
    const serialized = await dehydrateStepReturnValue(
      { count: 0, text: 'compressible'.repeat(200) },
      'wrun_cache_test',
      key,
      [],
      globalThis,
      false,
      false,
      true
    );
    const preparer = vi.fn<ReplayPayloadPreparer>(prepareReplayPayload);
    const cache = new ReplayPayloadCache(key, preparer);

    const prepared = await cache.prepareEventPayload(
      'evnt_encrypted',
      'result',
      serialized
    );
    const samePrepared = await cache.prepareEventPayload(
      'evnt_encrypted',
      'result',
      serialized
    );
    const first = deserializePreparedReplayPayload(prepared) as {
      count: number;
    };
    first.count = 99;
    const second = deserializePreparedReplayPayload(samePrepared) as {
      count: number;
    };

    expect(preparer).toHaveBeenCalledOnce();
    expect(second).not.toBe(first);
    expect(second.count).toBe(0);
  });

  it('bypasses legacy values and ignores missing event data during prewarm', async () => {
    const legacy = [0, { value: 1 }];
    const preparer = vi.fn<ReplayPayloadPreparer>((value) => ({ data: value }));
    const cache = new ReplayPayloadCache(undefined, preparer);

    await cache.prepareEventPayload('evnt_legacy', 'result', legacy);
    await cache.prepareEventPayload('evnt_legacy', 'result', legacy);
    expect(preparer).toHaveBeenCalledTimes(2);

    const events = makeEvents([legacy, legacy, legacy]);
    events[2] = { ...events[2], eventData: undefined } as unknown as Event;
    await cache.prewarm(makeRun(legacy), events);
    expect(preparer).toHaveBeenCalledTimes(2);
  });

  it('memoizes primitive step results, including undefined', async () => {
    for (const value of [0, false, '', null, undefined]) {
      const cache = new ReplayPayloadCache(undefined);
      const hydrate = vi.fn().mockResolvedValue(value);

      expect(await cache.getStepResult('evnt_result', hydrate)).toBe(value);
      expect(await cache.getStepResult('evnt_result', hydrate)).toBe(value);
      expect(hydrate).toHaveBeenCalledOnce();
    }
  });

  it('rehydrates mutable and oversized step results', async () => {
    const oversized = 'x'.repeat(4097);
    for (const value of [{ count: 0 }, oversized]) {
      const cache = new ReplayPayloadCache(undefined);
      const hydrate = vi
        .fn()
        .mockImplementation(async () =>
          typeof value === 'object' ? { ...value } : value
        );

      const first = await cache.getStepResult('evnt_result', hydrate);
      const second = await cache.getStepResult('evnt_result', hydrate);
      expect(hydrate).toHaveBeenCalledTimes(2);
      if (typeof value === 'object') expect(second).not.toBe(first);
    }
  });

  it('does not memoize failed step hydration', async () => {
    const cache = new ReplayPayloadCache(undefined);
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');

    await expect(cache.getStepResult('evnt_result', hydrate)).rejects.toThrow(
      'boom'
    );
    await expect(cache.getStepResult('evnt_result', hydrate)).resolves.toBe(
      'ok'
    );
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
