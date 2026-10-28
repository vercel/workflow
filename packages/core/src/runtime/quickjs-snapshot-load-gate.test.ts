/**
 * Pins when the QuickJS engine probes `world.snapshots.load` under a
 * non-zero `snapshotThreshold`. A snapshot is only ever saved once a run's
 * log has reached the threshold, so a resume of a run still below it must
 * not pay an awaited, guaranteed-miss load on its critical path.
 *
 * The QuickJS VM itself is mocked: `startQuickJSWorkflow` returns a canned
 * result, so only the load-gating decision is exercised.
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const runId = 'wrun_quickjs_snapshot_gate';

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
        deploymentId: 'dpl_snapshot_gate',
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

async function invoke(options: {
  log: Event[];
  threshold: number;
  preloadComplete?: boolean;
  outcome: 'suspended' | 'completed';
}) {
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_snapshot_gate',
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
  const load = vi.fn(async () => null);

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
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_snapshot_gate' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    experimental_snapshots: { load, save: vi.fn(), delete: vi.fn() },
  } as unknown as World);

  const result =
    options.outcome === 'completed'
      ? {
          completed: {
            result: await dehydrateStepReturnValue('done', runId, undefined),
          },
        }
      : { suspended: { pendingOperations: [] } };
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
    preloadedEvents: options.preloadComplete ? options.log : undefined,
    preloadedEventsComplete: options.preloadComplete,
  });
  return { load };
}

describe('QuickJS snapshot load gate', () => {
  beforeEach(async () => {
    // These runs have no encryption key; opt in to unencrypted snapshots
    // so the load gate is what's under test.
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

  it('never probes for a run without an encryption key unless opted in', async () => {
    delete process.env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED;
    const { load } = await invoke({
      log: makeLog(10),
      threshold: 1,
      outcome: 'completed',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('skips the load when a complete preload is shorter than the threshold', async () => {
    const { load } = await invoke({
      log: makeLog(3),
      threshold: 100,
      preloadComplete: true,
      outcome: 'completed',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('probes when a complete preload has reached the threshold', async () => {
    const { load } = await invoke({
      log: makeLog(3),
      threshold: 5,
      preloadComplete: true,
      outcome: 'completed',
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('skips the next load after this process saw the run suspend below the threshold', async () => {
    const log = makeLog(3);
    const first = await invoke({ log, threshold: 100, outcome: 'suspended' });
    // Nothing known yet: the first resume probes.
    expect(first.load).toHaveBeenCalledTimes(1);

    const second = await invoke({ log, threshold: 100, outcome: 'suspended' });
    expect(second.load).not.toHaveBeenCalled();
  });

  it('keeps probing once the run has reached the threshold', async () => {
    const log = makeLog(3);
    const first = await invoke({ log, threshold: 5, outcome: 'suspended' });
    expect(first.load).toHaveBeenCalledTimes(1);
    const second = await invoke({ log, threshold: 5, outcome: 'suspended' });
    expect(second.load).toHaveBeenCalledTimes(1);
  });
});
