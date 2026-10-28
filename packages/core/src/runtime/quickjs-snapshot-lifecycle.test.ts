/**
 * Pins the QuickJS engine's snapshot load/delete lifecycle against a World
 * whose snapshot storage is a mock: which stored snapshots are restored,
 * which are rejected (and so replayed in full), and when a terminal run's
 * snapshot is deleted.
 *
 * The QuickJS VM is mocked: `startQuickJSWorkflow` records whether it was
 * handed a snapshot and returns a canned result.
 */
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
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  MAX_SNAPSHOT_RNG_DRAWS,
  sealSnapshot,
} from './quickjs-snapshot-codec.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
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
  heap = new Uint8Array(2048).fill(1)
) {
  return {
    data: await sealSnapshot({ runId, heap, metadata, encryptionKey: key }),
    metadata,
  };
}

async function invoke(options: {
  log: Event[];
  threshold: number;
  withKey: boolean;
  stored: { data: Uint8Array; metadata: SnapshotMetadata } | null;
  restoreThrows?: boolean;
}) {
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
    experimental_snapshots: { load, save: vi.fn(), delete: del },
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
  startQuickJSWorkflow.mockImplementation(
    async (opts: { existingSnapshot?: unknown }) => {
      if (opts.existingSnapshot && options.restoreThrows) {
        throw new Error('restore failed');
      }
      return completed;
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
  return { load, del, restoredFrom };
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
