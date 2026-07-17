import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { importKey } from './encryption.js';
import {
  createReplayHydrationCache,
  eventPayloadKey,
  getOrPrepareReplayPayload,
  prewarmReplayPayloads,
  workflowInputPayloadKey,
} from './replay-hydration-cache.js';
import {
  dehydrateStepReturnValue,
  deserializePreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

function makeRun(input: Uint8Array): WorkflowRun {
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

function makeReplayEvents(payloads: Uint8Array[]): Event[] {
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

describe('replay payload preparation cache', () => {
  it('deduplicates in-flight preparation and supports a synchronous preparer', async () => {
    const cache = createReplayHydrationCache();
    const payload = new Uint8Array([1, 2, 3]);
    const preparer = vi.fn<ReplayPayloadPreparer>((value) => ({ data: value }));

    const first = getOrPrepareReplayPayload(
      cache,
      'event:one:result',
      payload,
      undefined,
      preparer
    );
    const second = getOrPrepareReplayPayload(
      cache,
      'event:one:result',
      payload,
      undefined,
      preparer
    );

    expect(first).toBe(second);
    expect((await first).data).toBe(payload);
    expect(preparer).toHaveBeenCalledTimes(1);
  });

  it('evicts failed preparation so the next replay can retry', async () => {
    const cache = createReplayHydrationCache();
    const payload = new Uint8Array([1]);
    const preparer = vi
      .fn<ReplayPayloadPreparer>()
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockReturnValueOnce({ data: payload });

    await expect(
      getOrPrepareReplayPayload(
        cache,
        'event:one:result',
        payload,
        undefined,
        preparer
      )
    ).rejects.toThrow('decrypt failed');

    await expect(
      getOrPrepareReplayPayload(
        cache,
        'event:one:result',
        payload,
        undefined,
        preparer
      )
    ).resolves.toEqual({ data: payload });
    expect(preparer).toHaveBeenCalledTimes(2);
  });

  it('starts workflow input, step result/error, and hook payload preparation concurrently', async () => {
    const input = new Uint8Array([0]);
    const payloads = [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ];
    const resolvers: Array<() => void> = [];
    const preparer = vi.fn<ReplayPayloadPreparer>(
      (value) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ data: value }));
        })
    );
    const cache = createReplayHydrationCache();

    const warming = prewarmReplayPayloads(
      cache,
      makeRun(input),
      makeReplayEvents(payloads),
      undefined,
      preparer
    );

    // Every preparer was invoked before any one of them resolved.
    expect(preparer).toHaveBeenCalledTimes(4);
    for (const resolve of resolvers.reverse()) resolve();
    await warming;

    expect(
      cache.preparedPayloads.has(workflowInputPayloadKey('wrun_cache_test'))
    ).toBe(true);
    expect(
      cache.preparedPayloads.has(eventPayloadKey('evnt_result', 'result'))
    ).toBe(true);
    expect(
      cache.preparedPayloads.has(eventPayloadKey('evnt_error', 'error'))
    ).toBe(true);
    expect(
      cache.preparedPayloads.has(eventPayloadKey('evnt_hook', 'payload'))
    ).toBe(true);

    await prewarmReplayPayloads(
      cache,
      makeRun(input),
      makeReplayEvents(payloads),
      undefined,
      preparer
    );
    expect(preparer).toHaveBeenCalledTimes(4);
  });

  it('caches decrypt/decompress output while reviving fresh objects', async () => {
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
    expect(serialized).toBeInstanceOf(Uint8Array);

    const cache = createReplayHydrationCache();
    const preparer = vi.fn<ReplayPayloadPreparer>(prepareReplayPayload);
    const prepared = await getOrPrepareReplayPayload(
      cache,
      'event:encrypted:result',
      serialized,
      key,
      preparer
    );
    const samePrepared = await getOrPrepareReplayPayload(
      cache,
      'event:encrypted:result',
      serialized,
      key,
      preparer
    );

    const first = deserializePreparedReplayPayload(prepared) as {
      count: number;
    };
    first.count = 99;
    const second = deserializePreparedReplayPayload(samePrepared) as {
      count: number;
    };

    expect(preparer).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.count).toBe(0);
  });

  it('does not cache legacy flattened values', async () => {
    const cache = createReplayHydrationCache();
    const legacy = [0, { value: 1 }];
    const preparer = vi.fn<ReplayPayloadPreparer>((value) => ({ data: value }));

    await getOrPrepareReplayPayload(
      cache,
      'legacy',
      legacy,
      undefined,
      preparer
    );
    await getOrPrepareReplayPayload(
      cache,
      'legacy',
      legacy,
      undefined,
      preparer
    );

    expect(preparer).toHaveBeenCalledTimes(2);
    expect(cache.preparedPayloads.size).toBe(0);
  });
});
