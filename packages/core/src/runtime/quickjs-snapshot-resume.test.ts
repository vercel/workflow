/**
 * Pins how a QuickJS resume of a snapshotted run gets its log and its
 * snapshot: the delta is sliced out of a complete preload when the preload
 * proves where the snapshot ends, and listed from the snapshot's cursor
 * otherwise; a snapshot read the queue handler started ahead of time is used
 * in place of a fresh one; and every way a snapshot can be unusable still
 * falls back to a full replay.
 *
 * The QuickJS VM is mocked: `startQuickJSWorkflow` records what it was handed
 * and returns a canned result.
 */
import {
  type Event,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotMetadata,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { quickjsWasiVersion } from './quickjs-assets.generated.js';
import { sealSnapshot } from './quickjs-snapshot-codec.js';
import {
  isSnapshotPrefetchEnabled,
  type LoadedSnapshot,
  noteRunAtSnapshotThreshold,
  prefetchQuickJSSnapshot,
  sliceSnapshotDelta,
} from './quickjs-snapshot-resume.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const runId = 'wrun_quickjs_snapshot_resume';
const startedAt = new Date('2026-05-19T12:00:00.000Z');

/** A log of `length` events with slot-numbered ids (or ULID-style ones). */
function makeLog(length: number, ids: 'slot' | 'opaque' = 'slot'): Event[] {
  const log: Event[] = [];
  for (let index = 0; index < length; index++) {
    const slot = index + 1;
    const base = {
      specVersion: SPEC_VERSION_CURRENT,
      runId,
      eventId:
        ids === 'slot'
          ? slotToEventId(slot)
          : `evnt_01JXT21Q00${String(slot).padStart(16, '0')}`,
      createdAt: new Date(+startedAt + slot * 100),
    };
    log.push(
      (index === 0
        ? {
            ...base,
            eventType: 'run_created',
            eventData: {
              deploymentId: 'dpl_resume',
              workflowName: 'workflow',
              input: [],
            },
          }
        : index === 1
          ? { ...base, eventType: 'run_started' }
          : {
              ...base,
              eventType: 'hook_created',
              correlationId: `hook_${slot}`,
              eventData: { token: `tok-${slot}` },
            }) as Event
    );
  }
  return log;
}

function snapshotMetadata(eventCount: number): SnapshotMetadata {
  return {
    eventsCursor: `cursor_after_${eventCount}`,
    createdAt: new Date('2026-05-19T12:00:05.000Z'),
    eventCount,
    rngDraws: 3,
    lastUlid: '01JXT21Q004W1Z0086ZPBBFKHX',
    serdeRootPtr: 1024,
    clockMs: 1_779_192_005_000,
    engineVersion: quickjsWasiVersion,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
  };
}

async function storedSnapshot(
  eventCount: number,
  heap = new Uint8Array(2048).fill(4)
): Promise<NonNullable<LoadedSnapshot>> {
  const metadata = snapshotMetadata(eventCount);
  return {
    // No run key: these tests opt in to unencrypted snapshots.
    data: await sealSnapshot({
      runId,
      heap,
      metadata,
      encryptionKey: undefined,
    }),
    metadata,
  };
}

async function invoke(options: {
  /** The run's log as `events.list` serves it. */
  log: Event[];
  /** What the queue handler preloaded, if anything. */
  preload?: { events: Event[]; cursor: string | null };
  stored: LoadedSnapshot;
  prefetch?: Promise<LoadedSnapshot>;
  threshold?: number;
  outcome?: 'completed' | 'suspended';
}) {
  const workflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_resume',
    attributes: {},
    specVersion: SPEC_VERSION_CURRENT,
    executionContext: { snapshotThreshold: options.threshold ?? 1 },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  } as WorkflowRun;

  // Serves the log after a cursor the way the World would: by slot.
  const list = vi.fn(
    async (params: { pagination?: { cursor?: string | null } }) => {
      const cursor = params.pagination?.cursor;
      const from = cursor?.startsWith('cursor_after_')
        ? Number(cursor.slice('cursor_after_'.length))
        : cursor
          ? options.log.findIndex((e) => e.eventId === cursor) + 1
          : 0;
      const data = options.log.slice(from);
      return {
        data,
        cursor: data.length > 0 ? data[data.length - 1].eventId : null,
        hasMore: false,
      };
    }
  );
  const load = vi.fn(async () => options.stored);

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list,
      create: vi.fn(async (_runId: string, request: { eventType: string }) => ({
        event: { ...request, runId, eventId: 'evnt_created' },
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_resume' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    experimental_snapshots: { load, save: vi.fn(), delete: vi.fn() },
  } as unknown as World);

  const result =
    options.outcome === 'suspended'
      ? { suspended: { pendingOperations: [] } }
      : {
          completed: {
            result: await dehydrateStepReturnValue('done', runId, undefined),
          },
        };
  startQuickJSWorkflow.mockResolvedValue({
    result,
    continueWithEvents: vi.fn(),
    snapshot: vi.fn(),
    dispose: vi.fn(),
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
    ...(options.preload
      ? {
          preloadedEvents: options.preload.events,
          preloadedEventsComplete: true,
          preloadedCursor: options.preload.cursor,
        }
      : {}),
    snapshotPrefetch: options.prefetch,
  });

  const vmCalls = startQuickJSWorkflow.mock.calls.map(
    ([opts]) =>
      opts as {
        events: Event[];
        existingSnapshot?: { data: Uint8Array } | null;
      }
  );
  return { list, load, vmCalls };
}

const ids = (events: Event[]) => events.map((e) => e.eventId);

describe('sliceSnapshotDelta', () => {
  it('returns the events after the snapshot position', () => {
    const log = makeLog(8);
    expect(ids(sliceSnapshotDelta(log, 5) ?? [])).toEqual(ids(log.slice(5)));
  });

  it('returns an empty delta when the preload ends at the snapshot', () => {
    expect(sliceSnapshotDelta(makeLog(5), 5)).toEqual([]);
  });

  it('refuses a preload shorter than the snapshot (the snapshot is newer)', () => {
    expect(sliceSnapshotDelta(makeLog(4), 5)).toBeUndefined();
  });

  it('refuses ids that are not slot-numbered', () => {
    expect(sliceSnapshotDelta(makeLog(8, 'opaque'), 5)).toBeUndefined();
  });

  it('refuses a preload with a gap before the boundary', () => {
    const log = makeLog(9);
    log.splice(2, 1);
    expect(sliceSnapshotDelta(log, 5)).toBeUndefined();
  });

  it('refuses a preload whose first delta event skips a slot', () => {
    const log = makeLog(9);
    log.splice(5, 1);
    expect(sliceSnapshotDelta(log, 5)).toBeUndefined();
  });

  it('refuses an invalid count', () => {
    expect(sliceSnapshotDelta(makeLog(5), -1)).toBeUndefined();
    expect(sliceSnapshotDelta(makeLog(5), 1.5)).toBeUndefined();
  });
});

describe('QuickJS snapshot resume', () => {
  beforeEach(async () => {
    process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED = '1';
    const { __resetSnapshotLatchesForTests } = await import(
      './quickjs-entrypoint.js'
    );
    __resetSnapshotLatchesForTests();
  });

  afterEach(() => {
    delete process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED;
    delete process.env.WORKFLOW_SNAPSHOT_PREFETCH;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('slices the delta out of a complete preload instead of listing it', async () => {
    const log = makeLog(9);
    const heap = new Uint8Array(2048).fill(8);
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: await storedSnapshot(6, heap),
    });
    expect(list).not.toHaveBeenCalled();
    expect(vmCalls).toHaveLength(1);
    expect(vmCalls[0].existingSnapshot?.data).toEqual(heap);
    expect(ids(vmCalls[0].events)).toEqual(ids(log.slice(6)));
  });

  it('lists from the snapshot cursor when the snapshot is newer than the preload', async () => {
    const log = makeLog(9);
    const stalePreload = log.slice(0, 4);
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: stalePreload, cursor: stalePreload[3].eventId },
      stored: await storedSnapshot(6),
    });
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      pagination: { cursor: 'cursor_after_6' },
    });
    expect(vmCalls[0].existingSnapshot).toBeTruthy();
    expect(ids(vmCalls[0].events)).toEqual(ids(log.slice(6)));
  });

  it('lists from the snapshot cursor when the preload ids cannot be verified', async () => {
    const log = makeLog(9, 'opaque');
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: await storedSnapshot(6),
    });
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      pagination: { cursor: 'cursor_after_6' },
    });
    expect(ids(vmCalls[0].events)).toEqual(ids(log.slice(6)));
  });

  it('lists from the snapshot cursor when the preload has no cursor', async () => {
    const log = makeLog(9);
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: null },
      stored: await storedSnapshot(6),
    });
    expect(list).toHaveBeenCalled();
    expect(ids(vmCalls[0].events)).toEqual(ids(log.slice(6)));
  });

  it('uses a prefetched snapshot instead of loading again', async () => {
    const log = makeLog(9);
    const heap = new Uint8Array(2048).fill(5);
    const prefetched = await storedSnapshot(6, heap);
    const { load, list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      prefetch: Promise.resolve(prefetched),
    });
    expect(load).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(vmCalls[0].existingSnapshot?.data).toEqual(heap);
  });

  it('replays the whole preload when the prefetch finds no snapshot', async () => {
    const log = makeLog(9);
    const { load, list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      prefetch: Promise.resolve(null),
    });
    expect(load).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(vmCalls[0].existingSnapshot).toBeFalsy();
    expect(ids(vmCalls[0].events)).toEqual(ids(log));
  });

  it('replays the whole preload when the prefetch failed', async () => {
    const log = makeLog(9);
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      prefetch: Promise.reject(new Error('snapshot storage unavailable')),
    });
    expect(list).not.toHaveBeenCalled();
    expect(vmCalls[0].existingSnapshot).toBeFalsy();
    expect(ids(vmCalls[0].events)).toEqual(ids(log));
  });

  it('replays the whole preload when the prefetched snapshot is from another engine build', async () => {
    const log = makeLog(9);
    const stale = await storedSnapshot(6);
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      prefetch: Promise.resolve({
        ...stale,
        metadata: { ...stale.metadata, engineVersion: '0.0.0-other' },
      }),
    });
    expect(list).not.toHaveBeenCalled();
    expect(vmCalls[0].existingSnapshot).toBeFalsy();
    expect(ids(vmCalls[0].events)).toEqual(ids(log));
  });

  it('replays the whole log when restoring the sliced snapshot fails', async () => {
    const log = makeLog(9);
    startQuickJSWorkflow.mockImplementationOnce(async () => {
      throw new Error('restore failed');
    });
    const { list, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: await storedSnapshot(6),
    });
    // The first boot had been handed the sliced delta; the fallback reads
    // the whole log back.
    expect(ids(vmCalls[0].events)).toEqual(ids(log.slice(6)));
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      pagination: { cursor: undefined },
    });
    expect(vmCalls[1].existingSnapshot).toBeFalsy();
    expect(ids(vmCalls[1].events)).toEqual(ids(log));
  });

  it('ignores a prefetch when the load gate would not probe', async () => {
    const log = makeLog(3);
    const prefetch = Promise.resolve(await storedSnapshot(2));
    const { load, vmCalls } = await invoke({
      log,
      preload: { events: log, cursor: log[2].eventId },
      stored: null,
      prefetch,
      threshold: 100,
    });
    expect(load).not.toHaveBeenCalled();
    expect(vmCalls[0].existingSnapshot).toBeFalsy();
    expect(ids(vmCalls[0].events)).toEqual(ids(log));
  });
});

describe('prefetchQuickJSSnapshot', () => {
  beforeEach(async () => {
    process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED = '1';
    const { __resetSnapshotLatchesForTests } = await import(
      './quickjs-entrypoint.js'
    );
    __resetSnapshotLatchesForTests();
  });

  afterEach(() => {
    delete process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED;
    delete process.env.WORKFLOW_SNAPSHOT_PREFETCH;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const storage = () => ({
    experimental_snapshots: {
      load: vi.fn(async () => null),
      save: vi.fn(),
      delete: vi.fn(),
    },
  });

  it('starts only for runs the engine saw at the snapshot threshold, until they finish', async () => {
    const log = makeLog(9);
    expect(prefetchQuickJSSnapshot(storage(), runId)).toBeUndefined();

    // Suspends with the log at the threshold: the next resume will probe.
    await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      threshold: 5,
      outcome: 'suspended',
    });
    const world = storage();
    const pending = prefetchQuickJSSnapshot(world, runId);
    expect(pending).toBeDefined();
    await expect(pending).resolves.toBeNull();
    expect(world.experimental_snapshots.load).toHaveBeenCalledWith(runId);

    // Completes: nothing will resume it.
    await invoke({
      log,
      preload: { events: log, cursor: log[8].eventId },
      stored: null,
      threshold: 5,
      outcome: 'completed',
    });
    expect(prefetchQuickJSSnapshot(storage(), runId)).toBeUndefined();
  });

  it('does not start for a run the engine saw below the threshold', async () => {
    const log = makeLog(3);
    await invoke({
      log,
      preload: { events: log, cursor: log[2].eventId },
      stored: null,
      threshold: 100,
      outcome: 'suspended',
    });
    expect(prefetchQuickJSSnapshot(storage(), runId)).toBeUndefined();
  });

  it('never rejects unobserved', async () => {
    noteRunAtSnapshotThreshold(runId);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const pending = prefetchQuickJSSnapshot(
        {
          experimental_snapshots: {
            load: vi.fn(async () => {
              throw new Error('boom');
            }),
            save: vi.fn(),
            delete: vi.fn(),
          },
        },
        runId
      );
      expect(pending).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(pending).rejects.toThrow('boom');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('honors the WORKFLOW_SNAPSHOT_PREFETCH kill switch', () => {
    noteRunAtSnapshotThreshold(runId);
    expect(isSnapshotPrefetchEnabled({})).toBe(true);
    expect(isSnapshotPrefetchEnabled({ WORKFLOW_SNAPSHOT_PREFETCH: '1' })).toBe(
      true
    );
    expect(isSnapshotPrefetchEnabled({ WORKFLOW_SNAPSHOT_PREFETCH: '0' })).toBe(
      false
    );
    expect(
      isSnapshotPrefetchEnabled({ WORKFLOW_SNAPSHOT_PREFETCH: 'FALSE' })
    ).toBe(false);
    process.env.WORKFLOW_SNAPSHOT_PREFETCH = '0';
    expect(prefetchQuickJSSnapshot(storage(), runId)).toBeUndefined();
  });

  it('does nothing for a World without snapshot storage', () => {
    noteRunAtSnapshotThreshold(runId);
    expect(prefetchQuickJSSnapshot({}, runId)).toBeUndefined();
  });
});
