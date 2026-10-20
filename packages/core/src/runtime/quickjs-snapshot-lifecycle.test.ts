/**
 * Pins the QuickJS engine's snapshot load/delete lifecycle against a World
 * whose snapshot storage is a mock: which stored snapshots are restored,
 * which are rejected (and so replayed in full), and when a terminal run's
 * snapshot is deleted.
 *
 * The QuickJS VM is mocked: `startQuickJSWorkflow` records whether it was
 * handed a snapshot and returns a canned result.
 */

import { createHash } from 'node:crypto';
import {
  type Event,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotMetadata,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveRunPayloadKeys,
  type RunPayloadKeys,
} from '../serialization/encryption.js';
import { dehydrateStepReturnValue } from '../serialization.js';
import { quickjsWasiVersion } from './quickjs-assets.generated.js';
import {
  isSnapshotDictionaryCompressionAvailable,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  MAX_SNAPSHOT_RNG_DRAWS,
  openSnapshot,
  type SnapshotDictionary,
  sealSnapshot,
} from './quickjs-snapshot-codec.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
const quickjsBaselineStubs = vi.hoisted(() => ({
  // The VM is mocked, so there is no baseline heap: snapshots are
  // compressed without a dictionary.
  registerPrebuiltQuickJSBaseline: () => {},
  getQuickJSBaselineDictionary: async () => undefined,
}));
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
  registerPrebuiltQuickJSBaseline: () => {},
  // Delegates, so a test can spy on the stub after the mock is built.
  getQuickJSBaselineDictionary: () =>
    quickjsBaselineStubs.getQuickJSBaselineDictionary(),
}));

const runId = 'wrun_quickjs_snapshot_lifecycle';
const rawKey = new Uint8Array(32).fill(7);

function makeLog(extraEvents: number): Event[] {
  const ulid = monotonicFactory();
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  let i = 0;
  const event = (data: Record<string, unknown>): Event => {
    const t = +startedAt + ++i * 100;
    return {
      specVersion: SPEC_VERSION_CURRENT,
      ...data,
      runId,
      eventId: `evnt_${ulid(t)}`,
      createdAt: new Date(t),
    } as Event;
  };
  const log = [
    event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'dpl_lifecycle',
        workflowName: 'workflow',
        input: [],
      },
    }),
    event({ eventType: 'run_started' }),
  ];
  for (let n = 0; n < extraEvents; n++) {
    log.push(
      event({
        eventType: 'hook_created',
        correlationId: `hook_${n}`,
        eventData: { token: `tok-${n}` },
      })
    );
  }
  return log;
}

function snapshotMetadata(
  overrides: Partial<SnapshotMetadata> = {}
): SnapshotMetadata {
  return {
    eventsCursor: 'cursor_snapshot',
    createdAt: new Date('2026-05-19T12:00:05.000Z'),
    eventCount: 4,
    rngDraws: 3,
    lastUlid: '01JXT21Q004W1Z0086ZPBBFKHX',
    serdeRootPtr: 1024,
    clockMs: 1_779_192_005_000,
    engineVersion: quickjsWasiVersion,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    ...overrides,
  };
}

async function sealed(
  metadata: SnapshotMetadata,
  key: RunPayloadKeys | undefined,
  heap = new Uint8Array(2048).fill(1),
  dictionary?: SnapshotDictionary
) {
  return {
    data: await sealSnapshot({
      runId,
      heap,
      metadata,
      encryptionKey: key,
      dictionary,
    }),
    metadata,
  };
}

function makeDictionary(seed: number): SnapshotDictionary {
  const bytes = new Uint8Array(64 * 1024);
  let x = seed;
  for (let i = 0; i < bytes.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

async function invoke(options: {
  log: Event[];
  threshold: number;
  withKey: boolean;
  stored: { data: Uint8Array; metadata: SnapshotMetadata } | null;
  restoreThrows?: boolean;
  /** The baseline heap this instance derives for the bundle, if any. */
  dictionary?: SnapshotDictionary;
  /** Suspend instead of completing, with this heap to snapshot. */
  suspendWithHeap?: Uint8Array;
}) {
  const getDictionary = vi
    .spyOn(quickjsBaselineStubs, 'getQuickJSBaselineDictionary')
    .mockImplementation(async () => options.dictionary as never);
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_lifecycle',
    specVersion: SPEC_VERSION_CURRENT,
    executionContext: { snapshotThreshold: options.threshold },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  } as WorkflowRun;

  let listCalls = 0;
  const listEvents = vi.fn(async () => {
    listCalls++;
    if (listCalls === 1) {
      return {
        data: [...options.log],
        cursor: options.log.at(-1)?.eventId ?? null,
        hasMore: false,
      };
    }
    return { data: [], cursor: null, hasMore: false };
  });
  const load = vi.fn(async () => options.stored);
  const del = vi.fn(async () => {});
  const save = vi.fn(async () => {});

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: listEvents,
      create: vi.fn(async (_runId: string, request: { eventType: string }) => ({
        event: { ...request, runId, eventId: 'evnt_created' },
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_lifecycle' }),
    getEncryptionKeyForRun: vi
      .fn()
      .mockResolvedValue(options.withKey ? rawKey : undefined),
    experimental_snapshots: { load, save, delete: del },
  } as unknown as World);

  const completed = {
    result: {
      completed: {
        result: await dehydrateStepReturnValue('done', runId, undefined),
      },
    },
    continueWithEvents: vi.fn(),
    snapshot: vi.fn(),
    dispose: vi.fn(),
  };
  const heap = options.suspendWithHeap;
  const suspended = heap && {
    result: { suspended: { pendingOperations: [] } },
    continueWithEvents: vi.fn(),
    snapshot: vi.fn(() => ({
      data: heap,
      rngDraws: 0,
      lastUlid: undefined,
      serdeRootPtr: 1024,
      clockMs: 0,
      engineVersion: quickjsWasiVersion,
    })),
    dispose: vi.fn(),
  };
  startQuickJSWorkflow.mockImplementation(
    async (opts: { existingSnapshot?: unknown }) => {
      if (opts.existingSnapshot && options.restoreThrows) {
        throw new Error('restore failed');
      }
      return suspended ?? completed;
    }
  );

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
  });
  // Deletes run off the response path.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const restoredFrom = startQuickJSWorkflow.mock.calls.map(
    ([opts]) =>
      (opts as { existingSnapshot?: { data: Uint8Array } | null })
        .existingSnapshot ?? undefined
  );
  return { load, del, save, restoredFrom, getDictionary };
}

describe('QuickJS snapshot lifecycle', () => {
  let key: RunPayloadKeys;

  beforeEach(async () => {
    key = await deriveRunPayloadKeys(rawKey);
    const { __resetSnapshotLatchesForTests } = await import(
      './quickjs-entrypoint.js'
    );
    __resetSnapshotLatchesForTests();
  });

  afterEach(() => {
    delete process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED;
    setWorld(undefined);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('restores a sealed, encrypted snapshot and deletes it when the run completes', async () => {
    const heap = new Uint8Array(4096).fill(9);
    const { del, restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: await sealed(snapshotMetadata(), key, heap),
    });
    expect(restoredFrom[0]?.data).toEqual(heap);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('deletes a snapshot whose restore failed once the run finishes', async () => {
    const { del, restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: await sealed(snapshotMetadata(), key),
      restoreThrows: true,
    });
    // Tried the snapshot, then fell back to a fresh boot.
    expect(restoredFrom[0]).toBeDefined();
    expect(restoredFrom[1]).toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('deletes on completion once the log reached the threshold, even when no snapshot was found', async () => {
    // A concurrent invocation's save may still land; the log length alone
    // says one may exist.
    const { del } = await invoke({
      log: makeLog(3),
      threshold: 2,
      withKey: true,
      stored: null,
    });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('does not delete for a run whose log stayed below the threshold', async () => {
    const { del } = await invoke({
      log: makeLog(1),
      threshold: 100,
      withKey: true,
      stored: null,
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('rejects a plaintext snapshot for a run that has an encryption key', async () => {
    const { restoredFrom, del } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: await sealed(snapshotMetadata(), undefined),
    });
    expect(restoredFrom).toEqual([undefined]);
    // Still cleaned up.
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('rejects a snapshot whose envelope metadata differs from the sealed metadata', async () => {
    const stored = await sealed(snapshotMetadata(), key);
    const { restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: {
        data: stored.data,
        metadata: { ...stored.metadata, eventsCursor: 'cursor_elsewhere' },
      },
    });
    expect(restoredFrom).toEqual([undefined]);
  });

  it('rejects a snapshot for another run', async () => {
    const metadata = snapshotMetadata();
    const data = await sealSnapshot({
      runId: 'wrun_other',
      heap: new Uint8Array(2048),
      metadata,
      encryptionKey: key,
    });
    const { restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: { data, metadata },
    });
    expect(restoredFrom).toEqual([undefined]);
  });

  it('rejects out-of-bounds rngDraws before doing any restore work', async () => {
    const metadata = snapshotMetadata({
      rngDraws: MAX_SNAPSHOT_RNG_DRAWS + 1,
    });
    const { restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: await sealed(metadata, key),
    });
    expect(restoredFrom).toEqual([undefined]);
  });

  it('refuses to inflate a snapshot past the plaintext ceiling', async () => {
    // A well-formed, correctly sealed snapshot whose heap is over the
    // ceiling: small on the wire, huge once inflated.
    const stored = await sealed(
      snapshotMetadata(),
      key,
      new Uint8Array(MAX_SNAPSHOT_PLAINTEXT_BYTES + 1024 * 1024)
    );
    expect(stored.data.byteLength).toBeLessThan(1024 * 1024);
    const { restoredFrom } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored,
    });
    expect(restoredFrom).toEqual([undefined]);
  });

  describe.skipIf(!isSnapshotDictionaryCompressionAvailable())(
    'compressed against the baseline heap',
    () => {
      it('restores a snapshot compressed against the baseline this instance derives', async () => {
        const dictionary = makeDictionary(1);
        // A heap that mostly repeats the baseline, as a run's heap does.
        const heap = dictionary.bytes.slice();
        heap.fill(5, 0, 512);
        const metadata = snapshotMetadata({
          baselineDigest: dictionary.digest,
        });
        const stored = await sealed(metadata, key, heap, dictionary);
        const plain = await sealed(snapshotMetadata(), key, heap);
        expect(stored.data.byteLength).toBeLessThan(plain.data.byteLength / 4);
        const { restoredFrom, getDictionary } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored,
          dictionary,
        });
        expect(getDictionary).toHaveBeenCalled();
        expect(restoredFrom[0]?.data).toEqual(heap);
      });

      it('saves a snapshot compressed against the baseline heap', async () => {
        const dictionary = makeDictionary(3);
        const heap = dictionary.bytes.slice();
        heap.fill(7, 100, 300);
        const { save } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored: null,
          dictionary,
          suspendWithHeap: heap,
        });
        expect(save).toHaveBeenCalledTimes(1);
        const [, data, metadata] = save.mock.calls[0] as unknown as [
          string,
          Uint8Array,
          SnapshotMetadata,
        ];
        expect(metadata.baselineDigest).toBe(dictionary.digest);
        await expect(
          openSnapshot({
            runId,
            stored: data,
            metadata,
            encryptionKey: key,
            dictionary,
          })
        ).resolves.toEqual(heap);
        // Without the dictionary it cannot be opened.
        await expect(
          openSnapshot({ runId, stored: data, metadata, encryptionKey: key })
        ).rejects.toMatchObject({ reason: 'dictionary_unavailable' });
      });

      it('saves without a digest when there is no baseline heap', async () => {
        const heap = new Uint8Array(8192).fill(4);
        const { save } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored: null,
          dictionary: undefined,
          suspendWithHeap: heap,
        });
        expect(save).toHaveBeenCalledTimes(1);
        const [, data, metadata] = save.mock.calls[0] as unknown as [
          string,
          Uint8Array,
          SnapshotMetadata,
        ];
        expect(metadata.baselineDigest).toBeUndefined();
        await expect(
          openSnapshot({ runId, stored: data, metadata, encryptionKey: key })
        ).resolves.toEqual(heap);
      });

      it('treats a snapshot as a miss when this instance has no baseline', async () => {
        const dictionary = makeDictionary(1);
        const metadata = snapshotMetadata({
          baselineDigest: dictionary.digest,
        });
        const { restoredFrom, del } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored: await sealed(metadata, key, undefined, dictionary),
          dictionary: undefined,
        });
        expect(restoredFrom).toEqual([undefined]);
        expect(del).toHaveBeenCalledTimes(1);
      });

      it('treats a snapshot as a miss when the baseline differs', async () => {
        const dictionary = makeDictionary(1);
        const metadata = snapshotMetadata({
          baselineDigest: dictionary.digest,
        });
        const { restoredFrom } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored: await sealed(metadata, key, undefined, dictionary),
          dictionary: makeDictionary(2),
        });
        expect(restoredFrom).toEqual([undefined]);
      });

      it('rejects bytes compressed against another baseline than the digest names', async () => {
        // The digest is sealed, but the dictionary is not: a frame built
        // against different bytes must fail its checksum, not decode.
        const real = makeDictionary(1);
        const other = makeDictionary(2);
        const metadata = snapshotMetadata({ baselineDigest: real.digest });
        const data = await sealSnapshot({
          runId,
          // Matches the dictionary it is compressed against, so the frame
          // references it.
          heap: other.bytes,
          metadata,
          encryptionKey: key,
          dictionary: { bytes: other.bytes, digest: real.digest },
        });
        const { restoredFrom } = await invoke({
          log: makeLog(3),
          threshold: 1,
          withKey: true,
          stored: { data, metadata },
          dictionary: real,
        });
        expect(restoredFrom).toEqual([undefined]);
      });
    }
  );

  it('rejects a baselineDigest that is not a SHA-256 digest', async () => {
    const stored = await sealed(snapshotMetadata(), key);
    const { restoredFrom, getDictionary } = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: true,
      stored: {
        data: stored.data,
        metadata: { ...stored.metadata, baselineDigest: 'not-a-digest' },
      },
    });
    expect(restoredFrom).toEqual([undefined]);
    expect(getDictionary).not.toHaveBeenCalled();
  });

  it('restores an unencrypted snapshot only when opted in', async () => {
    const heap = new Uint8Array(2048).fill(3);
    const withoutOptIn = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: false,
      stored: await sealed(snapshotMetadata(), undefined, heap),
    });
    expect(withoutOptIn.load).not.toHaveBeenCalled();

    vi.clearAllMocks();
    process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED = '1';
    const optedIn = await invoke({
      log: makeLog(3),
      threshold: 1,
      withKey: false,
      stored: await sealed(snapshotMetadata(), undefined, heap),
    });
    expect(optedIn.restoredFrom[0]?.data).toEqual(heap);
  });
});
