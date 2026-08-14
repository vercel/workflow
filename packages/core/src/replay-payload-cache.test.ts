import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { importKey } from './encryption.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { prepareReplayPayload } from './serialization/replay.js';
import {
  dehydrateStepReturnValue,
  deserializePreparedReplayPayload,
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
  it('deduplicates synchronous preparation without creating a promise', () => {
    const payload = new Uint8Array([1]);
    const preparer = vi.fn<typeof prepareReplayPayload>((value) => value);
    const cache = new ReplayPayloadCache(undefined, preparer);

    const first = cache.prepareEventPayload('evnt_one', payload);
    const second = cache.prepareEventPayload('evnt_one', payload);

    expect(first).toBe(second);
    expect(first).toEqual(payload);
    expect(preparer).toHaveBeenCalledOnce();
  });

  it('hydrates and memoizes a primitive without creating a promise', () => {
    const payload = new Uint8Array([1]);
    const hydrate = vi.fn(() => 42);
    const cache = new ReplayPayloadCache(undefined, (value) => value);

    expect(cache.getEventValue('evnt_one', payload, hydrate)).toBe(42);
    expect(cache.getEventValue('evnt_one', payload, hydrate)).toBe(42);
    expect(hydrate).toHaveBeenCalledOnce();
  });

  it('keeps a failed prewarm until its consumer observes it, then retries', async () => {
    const payload = new Uint8Array([1]);
    const run = makeRun(payload);
    const preparer = vi
      .fn<typeof prepareReplayPayload>()
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockReturnValueOnce(payload);
    const cache = new ReplayPayloadCache(undefined, preparer);

    cache.prewarm(run, []);
    await Promise.resolve();
    expect(() => cache.prepareWorkflowInput(run)).toThrow('decrypt failed');
    expect(preparer).toHaveBeenCalledOnce();

    expect(cache.prepareWorkflowInput(run)).toEqual(payload);
    expect(preparer).toHaveBeenCalledTimes(2);
  });

  it('prewarms workflow, step, error, and hook payloads concurrently', async () => {
    const payloads = [0, 1, 2, 3].map((value) => new Uint8Array([value]));
    const resolvers: Array<() => void> = [];
    const preparer = vi.fn<typeof prepareReplayPayload>(
      (value) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve(value));
        })
    );
    const cache = new ReplayPayloadCache(undefined, preparer);
    const run = makeRun(payloads[0]);
    const events = makeEvents(payloads.slice(1));

    cache.prewarm(run, events);
    expect(preparer).toHaveBeenCalledTimes(4);
    for (const resolve of resolvers.reverse()) resolve();
    await Promise.all([
      cache.prepareWorkflowInput(run),
      ...events.map((event) => {
        switch (event.eventType) {
          case 'step_completed':
            return cache.prepareEventPayload(
              event.eventId,
              event.eventData?.result
            );
          case 'step_failed':
            return cache.prepareEventPayload(
              event.eventId,
              event.eventData?.error
            );
          case 'hook_received':
            return cache.prepareEventPayload(
              event.eventId,
              event.eventData?.payload
            );
          default:
            throw new Error(`Unexpected event: ${event.eventType}`);
        }
      }),
    ]);

    cache.prewarm(run, events);
    expect(preparer).toHaveBeenCalledTimes(4);
  });

  it('prepares streamed events synchronously inside the decoder callback', async () => {
    const payload = new Uint8Array([1]);
    const order: string[] = [];
    const preparer = vi.fn<typeof prepareReplayPayload>((value) => {
      order.push('prepare');
      return value;
    });
    const cache = new ReplayPayloadCache(undefined, preparer);
    const [event] = makeEvents([payload]);

    cache.observeEvent(event, () => order.push('start'));
    expect(preparer).toHaveBeenCalledOnce();
    expect(order).toEqual(['start', 'prepare']);

    // Re-observing a cache hit does not move the preparation-span boundary.
    cache.observeEvent(event, () => order.push('cached-start'));
    expect(order).toEqual(['start', 'prepare']);

    expect(cache.prepareEventPayload(event.eventId, payload)).toEqual(payload);
  });

  it('prepares queued stream events as soon as the run key resolves', async () => {
    const payload = new Uint8Array([1]);
    const preparer = vi.fn<typeof prepareReplayPayload>((value) => value);
    let resolveKey!: (key: undefined) => void;
    const key = new Promise<undefined>((resolve) => {
      resolveKey = resolve;
    });
    const cache = ReplayPayloadCache.waitingForKey(key, preparer);
    const [event] = makeEvents([payload]);

    cache.observeEvent(event);
    expect(preparer).not.toHaveBeenCalled();
    const preparation = cache.prepareEventPayload(event.eventId, payload);

    resolveKey(undefined);
    await expect(preparation).resolves.toEqual(payload);
    expect(preparer).toHaveBeenCalledOnce();
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
    const preparer = vi.fn<typeof prepareReplayPayload>(prepareReplayPayload);
    const cache = new ReplayPayloadCache(key, preparer);

    const directPreparation = prepareReplayPayload(serialized, key);
    expect(directPreparation).not.toBeInstanceOf(Promise);
    await directPreparation;

    const prepared = await cache.prepareEventPayload(
      'evnt_encrypted',
      serialized
    );
    const samePrepared = await cache.prepareEventPayload(
      'evnt_encrypted',
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

  it('rescans a log whose missing events were filled in below the scanned prefix', async () => {
    // A stale-snapshot (412) restart replaces the log with a corrected one, so
    // the events it was missing appear BELOW the length already scanned and
    // shift every later position. Resuming from that length skips exactly the
    // events the reload was for, which is what `resetScan` exists to prevent.
    const payloads = [0, 1, 2].map((value) => new Uint8Array([value]));
    const preparer = vi.fn<typeof prepareReplayPayload>((value) => value);
    const cache = new ReplayPayloadCache(undefined, preparer);
    const run = makeRun(undefined);
    const [first, missing, second] = makeEvents(payloads);

    await cache.prewarm(run, [first, second]);
    expect(preparer).toHaveBeenCalledTimes(2);

    // Positional resume: `missing` sits inside the scanned prefix, so it is
    // skipped and its payload is only prepared on demand.
    await cache.prewarm(run, [first, missing, second]);
    expect(preparer).toHaveBeenCalledTimes(2);

    cache.resetScan();
    await cache.prewarm(run, [first, missing, second]);
    // Only the inserted event is new: the other two are keyed by event id and
    // stay prepared across the rescan.
    expect(preparer).toHaveBeenCalledTimes(3);
    expect(preparer).toHaveBeenLastCalledWith(payloads[1], undefined);
  });

  it('bypasses legacy values and ignores missing event data during prewarm', async () => {
    const legacy = [0, { value: 1 }];
    const preparer = vi.fn<typeof prepareReplayPayload>((value) => value);
    const cache = new ReplayPayloadCache(undefined, preparer);

    await cache.prepareEventPayload('evnt_legacy', legacy);
    await cache.prepareEventPayload('evnt_legacy', legacy);
    expect(preparer).not.toHaveBeenCalled();

    const events = makeEvents([legacy, legacy, legacy]);
    events[2] = { ...events[2], eventData: undefined } as unknown as Event;
    await cache.prewarm(makeRun(legacy), events);
    expect(preparer).not.toHaveBeenCalled();
  });

  it('memoizes primitive step results, including undefined', async () => {
    for (const value of [0, false, '', null, undefined]) {
      const cache = new ReplayPayloadCache();
      const hydrate = vi.fn().mockResolvedValue(value);

      expect(await cache.getEventValue('evnt_result', undefined, hydrate)).toBe(
        value
      );
      expect(await cache.getEventValue('evnt_result', undefined, hydrate)).toBe(
        value
      );
      expect(hydrate).toHaveBeenCalledOnce();
    }
  });

  it('isolates primitive values by event id', async () => {
    const cache = new ReplayPayloadCache();
    const result = vi.fn().mockResolvedValue('result');
    const error = vi.fn().mockResolvedValue('error');

    await expect(
      cache.getEventValue('evnt_result', undefined, result)
    ).resolves.toBe('result');
    await expect(
      cache.getEventValue('evnt_error', undefined, error)
    ).resolves.toBe('error');
    expect(cache.getEventValue('evnt_result', undefined, result)).toBe(
      'result'
    );
    expect(result).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('rehydrates mutable results and memoizes primitives of any size', async () => {
    const oversized = 'x'.repeat(4097);
    for (const value of [{ count: 0 }, oversized]) {
      const cache = new ReplayPayloadCache();
      const hydrate = vi
        .fn()
        .mockImplementation(async () =>
          typeof value === 'object' ? { ...value } : value
        );

      const first = await cache.getEventValue(
        'evnt_result',
        undefined,
        hydrate
      );
      const second = await cache.getEventValue(
        'evnt_result',
        undefined,
        hydrate
      );
      if (typeof value === 'object') {
        expect(hydrate).toHaveBeenCalledTimes(2);
        expect(second).not.toBe(first);
      } else {
        expect(hydrate).toHaveBeenCalledOnce();
        expect(second).toBe(first);
      }
    }
  });

  it('does not memoize failed step hydration', async () => {
    const cache = new ReplayPayloadCache();
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');

    await expect(
      cache.getEventValue('evnt_result', undefined, hydrate)
    ).rejects.toThrow('boom');
    await expect(
      cache.getEventValue('evnt_result', undefined, hydrate)
    ).resolves.toBe('ok');
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
