/**
 * Wiring coverage for the snapshot event-ceiling exemption: the ceiling the
 * replay loop hands the QuickJS engine is the one `resolveMaxEventsLimit`
 * produced, not the raw `maxEvents` the World advertised.
 *
 * Drives the real `workflowEntrypoint` with the engine itself mocked, so the
 * assertion is on the value that crosses the seam. Both setup paths are
 * covered, because each threads the ceiling separately: turbo backgrounds
 * `run_started` and backfills the ceiling off that response (and needs
 * `runInput` on the message to take that branch), while the sequential path
 * awaits it. The engine's own enforcement of whatever it is handed is covered
 * by quickjs-snapshot-generations.test.ts, and the resolution rules by
 * event-ceiling.test.ts.
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const runWorkflowWithQuickJS = vi.fn();
vi.mock('./quickjs-entrypoint.js', () => ({ runWorkflowWithQuickJS }));

/** The World's advertised ceiling, small enough to be unmistakable. */
const WORLD_MAX_EVENTS = 10;

/**
 * Dispatch one workflow queue delivery for a run with `executionContext`,
 * against a World that advertises `WORLD_MAX_EVENTS` on `run_started`.
 *
 * `turbo` puts `runInput` on the message, which is what sends the runtime
 * down the backgrounded `run_started` branch. `omitRunFromResponse` drops the
 * run entity from that response, leaving the message's stamped context as the
 * only policy the backfill can read.
 */
async function dispatchRun(
  executionContext: Record<string, unknown>,
  { turbo = false, omitRunFromResponse = false } = {}
) {
  const runId = 'wrun_quickjs_event_ceiling';
  const workflowName = 'workflow';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: new Uint8Array(),
    deploymentId: 'dpl_quickjs_event_ceiling',
    specVersion: SPEC_VERSION_CURRENT,
    executionContext,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const event = (
    eventId: string,
    data: Omit<Event, 'runId' | 'eventId' | 'createdAt'>
  ): Event => ({ ...data, runId, eventId, createdAt: startedAt });
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
    events: {
      list: vi.fn(async () => ({
        data: [runCreated, runStarted],
        cursor: runStarted.eventId,
        hasMore: false,
      })),
      create: vi.fn(async () => ({
        event: runStarted,
        ...(omitRunFromResponse ? {} : { run: workflowRun }),
        events: [runCreated, runStarted],
        cursor: runStarted.eventId,
        hasMore: false,
        maxEvents: WORLD_MAX_EVENTS,
      })),
    },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_queued' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  await workflowEntrypoint('// QuickJS is mocked')(
    new Request('https://example.test')
  );
  expect(dispatch).toBeDefined();
  await dispatch?.(
    {
      runId,
      ...(turbo
        ? {
            runInput: {
              input: workflowRun.input,
              deploymentId: workflowRun.deploymentId,
              workflowName,
              specVersion: SPEC_VERSION_CURRENT,
              executionContext,
            },
          }
        : {}),
    },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );
}

/** The ceiling the engine was handed on the single dispatch above. */
function handedCeiling(): number | undefined {
  expect(runWorkflowWithQuickJS).toHaveBeenCalledTimes(1);
  return runWorkflowWithQuickJS.mock.calls[0][0].maxEventsLimit;
}

describe.each([
  ['sequential run_started', false],
  ['turbo', true],
])('QuickJS event-ceiling threading (%s)', (_label, turbo) => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    delete process.env.WORKFLOW_MAX_EVENTS_OVERRIDE;
    delete process.env.WORKFLOW_SNAPSHOT_THRESHOLD;
  });

  it('lifts the ceiling for a snapshotting run', async () => {
    await dispatchRun(
      { workflowVm: 'quickjs', snapshotThreshold: 500 },
      { turbo }
    );
    expect(handedCeiling()).toBeUndefined();
  });

  it('keeps the ceiling for a QuickJS run without snapshotting', async () => {
    await dispatchRun({ workflowVm: 'quickjs' }, { turbo });
    expect(handedCeiling()).toBe(WORLD_MAX_EVENTS);
  });

  it('lifts the ceiling when the handler env enables snapshotting', async () => {
    // The gap a World cannot see: nothing about snapshotting is persisted on
    // this run, so its advertised ceiling cannot account for the policy.
    process.env.WORKFLOW_SNAPSHOT_THRESHOLD = '500';
    await dispatchRun({ workflowVm: 'quickjs' }, { turbo });
    expect(handedCeiling()).toBeUndefined();
  });

  it('still honors WORKFLOW_MAX_EVENTS_OVERRIDE on a snapshotting run', async () => {
    process.env.WORKFLOW_MAX_EVENTS_OVERRIDE = '4';
    await dispatchRun(
      { workflowVm: 'quickjs', snapshotThreshold: 500 },
      { turbo }
    );
    expect(handedCeiling()).toBe(4);
  });
});

describe('QuickJS event-ceiling threading (turbo, run omitted)', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('reads the policy off the message when the response carries no run', async () => {
    await dispatchRun(
      { workflowVm: 'quickjs', snapshotThreshold: 500 },
      { turbo: true, omitRunFromResponse: true }
    );
    expect(handedCeiling()).toBeUndefined();
  });

  it('keeps the ceiling when neither the response nor the message is exempt', async () => {
    await dispatchRun(
      { workflowVm: 'quickjs' },
      { turbo: true, omitRunFromResponse: true }
    );
    expect(handedCeiling()).toBe(WORLD_MAX_EVENTS);
  });
});
