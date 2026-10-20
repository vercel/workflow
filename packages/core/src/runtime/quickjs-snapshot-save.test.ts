/**
 * Pins the metadata the QuickJS engine hands `world.snapshots.save`,
 * including the informational size fields a World reports for tracking
 * (world-vercel sends them as `X-Snapshot-*` headers).
 *
 * The QuickJS VM is mocked: `startQuickJSWorkflow` returns a suspended
 * session whose snapshot is a canned heap.
 */
import {
  type Event,
  type SnapshotMetadata,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { quickjsWasiVersion } from './quickjs-assets.generated.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const runId = 'wrun_quickjs_snapshot_save';

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
        deploymentId: 'dpl_save',
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

beforeEach(async () => {
  // No encryption key here; opt in so the save path runs.
  process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED = '1';
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

it('reports the uncompressed heap size and the covered event count', async () => {
  const log = makeLog(5);
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_save',
    specVersion: SPEC_VERSION_CURRENT,
    executionContext: { snapshotThreshold: 1 },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  } as WorkflowRun;
  const save = vi.fn(async () => {});
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      // The full log once, then nothing new.
      list: vi
        .fn()
        .mockResolvedValueOnce({
          data: [...log],
          cursor: log.at(-1)?.eventId ?? null,
          hasMore: false,
        })
        .mockResolvedValue({ data: [], cursor: null, hasMore: false }),
      create: vi.fn(async (_runId: string, request: { eventType: string }) => ({
        event: { ...request, runId, eventId: 'evnt_created' },
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_save' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    experimental_snapshots: {
      load: vi.fn(async () => null),
      save,
      delete: vi.fn(),
    },
  } as unknown as World);

  const heap = new Uint8Array(8192).fill(4);
  startQuickJSWorkflow.mockResolvedValue({
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
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
  });
  // The save runs off the response path.
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

  const [, stored, metadata] = save.mock.calls[0] as unknown as [
    string,
    Uint8Array,
    SnapshotMetadata,
  ];
  expect(metadata.plaintextBytes).toBe(heap.byteLength);
  expect(metadata.eventCount).toBe(log.length);
  // The stored bytes are the sealed (compressed) frame, not the heap.
  expect(stored.byteLength).toBeLessThan(heap.byteLength);
});
