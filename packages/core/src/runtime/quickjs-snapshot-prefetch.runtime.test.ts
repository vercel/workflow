/**
 * Pins the queue handler's side of the QuickJS snapshot prefetch: for a run
 * this process saw at the snapshot threshold, the snapshot read starts before
 * the delivery's setup request (`run_started`, or the lazy hook
 * `hook_received`) has returned, and is handed to the engine; for any other
 * run nothing is read.
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import {
  __resetSnapshotPrefetchForTests,
  type LoadedSnapshot,
  noteRunAtSnapshotThreshold,
} from './quickjs-snapshot-resume.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const runWorkflowWithQuickJS = vi.fn();
vi.mock('./quickjs-entrypoint.js', () => ({ runWorkflowWithQuickJS }));

const runId = 'wrun_quickjs_snapshot_prefetch';
const workflowName = 'workflow';
const startedAt = new Date('2026-05-19T12:00:00.000Z');
const workflowRun: WorkflowRun = {
  runId,
  workflowName,
  status: 'running',
  input: new Uint8Array(),
  deploymentId: 'dpl_quickjs_snapshot_prefetch',
  attributes: {},
  specVersion: SPEC_VERSION_CURRENT,
  executionContext: { workflowVm: 'quickjs' },
  startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
};
const event = (
  eventId: string,
  data: Omit<Event, 'runId' | 'eventId' | 'createdAt'>
): Event => ({ ...data, runId, eventId, createdAt: startedAt }) as Event;
const runCreated = event('evnt_1', {
  eventType: 'run_created',
  specVersion: SPEC_VERSION_CURRENT,
  eventData: {
    deploymentId: workflowRun.deploymentId,
    workflowName,
    input: workflowRun.input,
  },
});
const runStarted = event('evnt_2', {
  eventType: 'run_started',
  specVersion: SPEC_VERSION_CURRENT,
});

async function deliver(message: Record<string, unknown>) {
  const stored: LoadedSnapshot = null;
  const order: string[] = [];
  let loadCalled: () => void = () => {};
  const loadStarted = new Promise<void>((resolve) => {
    loadCalled = resolve;
  });
  const load = vi.fn(async () => {
    order.push('snapshot.load');
    loadCalled();
    return stored;
  });
  // The setup request holds its response until the snapshot read has
  // started (or a short timeout passes), so a read that only starts after
  // setup shows up as `load` following `setup.resolved`.
  const create = vi.fn(
    async (
      _runId: string,
      request: {
        eventType: string;
        correlationId?: string;
        eventData?: unknown;
      },
      params?: { resumeId?: string }
    ) => {
      order.push(`${request.eventType}.sent`);
      await Promise.race([
        loadStarted,
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      order.push(`${request.eventType}.resolved`);
      if (request.eventType === 'hook_received') {
        const hookReceived = event('evnt_4', {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: request.correlationId as string,
          resumeId: params?.resumeId,
          eventData: request.eventData,
        } as Omit<Event, 'runId' | 'eventId' | 'createdAt'>);
        return {
          event: hookReceived,
          run: workflowRun,
          events: [runCreated, runStarted, hookReceived],
          cursor: 'cursor-after-hook-received',
          hasMore: false,
          maxEvents: 10_000,
        };
      }
      return {
        event: runStarted,
        run: workflowRun,
        events: [runCreated, runStarted],
        cursor: 'cursor-after-run-started',
        hasMore: false,
      };
    }
  );
  let dispatch:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    createQueueHandler: vi.fn((_prefix, handler) => {
      dispatch = handler;
      return vi.fn();
    }),
    events: { list: vi.fn(), create },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_queued' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    experimental_snapshots: { load, save: vi.fn(), delete: vi.fn() },
  } as unknown as World);

  await workflowEntrypoint('// QuickJS is mocked')(
    new Request('https://example.test')
  );
  await dispatch?.(message, {
    queueName: `__wkf_workflow_${workflowName}`,
    messageId: 'msg_workflow',
    attempt: 1,
  });
  const engineCall = runWorkflowWithQuickJS.mock.calls[0]?.[0] as
    | {
        snapshotPrefetch?: Promise<LoadedSnapshot>;
        preloadedCursor?: string | null;
      }
    | undefined;
  return { load, order, engineCall };
}

describe('QuickJS snapshot prefetch in the queue handler', () => {
  beforeEach(() => {
    __resetSnapshotPrefetchForTests();
  });

  afterEach(() => {
    __resetSnapshotPrefetchForTests();
    delete process.env.WORKFLOW_SNAPSHOT_PREFETCH;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('reads the snapshot alongside run_started for a run at the threshold', async () => {
    noteRunAtSnapshotThreshold(runId);
    const { load, order, engineCall } = await deliver({ runId });
    expect(load).toHaveBeenCalledTimes(1);
    expect(order.indexOf('snapshot.load')).toBeLessThan(
      order.indexOf('run_started.resolved')
    );
    expect(engineCall?.snapshotPrefetch).toBeInstanceOf(Promise);
    await expect(engineCall?.snapshotPrefetch).resolves.toBeNull();
  });

  it('reads the snapshot alongside a lazy hook resume', async () => {
    noteRunAtSnapshotThreshold(runId);
    const { load, order, engineCall } = await deliver({
      runId,
      hookInput: {
        hookId: 'hook_1',
        resumeId: monotonicFactory()(+startedAt + 5000),
        token: 'token',
        payload: new Uint8Array([1, 2, 3]),
        payloadDigest: 'digest',
      },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(order.indexOf('snapshot.load')).toBeLessThan(
      order.indexOf('hook_received.resolved')
    );
    // The lazy fast path served setup on its own: no run_started.
    expect(order).not.toContain('run_started.sent');
    expect(engineCall?.preloadedCursor).toBe('cursor-after-hook-received');
    expect(engineCall?.snapshotPrefetch).toBeInstanceOf(Promise);
  });

  it('reads nothing for a run it has not seen at the threshold', async () => {
    const { load, engineCall } = await deliver({ runId });
    expect(load).not.toHaveBeenCalled();
    expect(engineCall).toBeDefined();
    expect(engineCall?.snapshotPrefetch).toBeUndefined();
  });

  it('reads nothing ahead of setup with the kill switch set', async () => {
    process.env.WORKFLOW_SNAPSHOT_PREFETCH = '0';
    noteRunAtSnapshotThreshold(runId);
    const { load, engineCall } = await deliver({ runId });
    expect(load).not.toHaveBeenCalled();
    expect(engineCall?.snapshotPrefetch).toBeUndefined();
  });
});
