import {
  ThrottleError,
  WorkflowRunCancelledError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { dehydrateWorkflowReturnValue } from '../serialization.js';
import { Run } from './run.js';
import { transientReadRetryDelayMs } from './transient-read-retry.js';
import { setWorld } from './world.js';

const RUN_ID = 'wrun_01JB0000000000000000000000';

const baseRun = {
  runId: RUN_ID,
  workflowName: 'test-workflow',
  specVersion: 2,
  input: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  startedAt: new Date(0),
  deploymentId: 'test-deployment',
};

const runningRun = { ...baseRun, status: 'running' as const };
const cancelledRun = {
  ...baseRun,
  status: 'cancelled' as const,
  completedAt: new Date(0),
};

const timedOut = () =>
  new WorkflowWorldError(`GET /v2/runs/${RUN_ID} timed out after 60003ms`, {
    code: 'TIMEOUT',
  });
const serverError = () =>
  new WorkflowWorldError('Internal Server Error', { status: 500 });

function createWorld(runs: Partial<World['runs']>): World {
  return {
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: vi.fn().mockResolvedValue(runningRun),
      ...runs,
    },
    events: {
      list: vi
        .fn()
        .mockResolvedValue({ data: [], hasMore: false, cursor: null }),
      create: vi.fn(),
    },
    queue: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
}

describe('Run.returnValue on a transient World error', () => {
  const envName = 'WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS';
  const originalValue = process.env[envName];

  beforeEach(() => {
    vi.useFakeTimers();
    process.env[envName] = '1000';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalValue === undefined) delete process.env[envName];
    else process.env[envName] = originalValue;
    setWorld(undefined as unknown as World);
  });

  it('keeps waiting after a timed out runs.get while the run is running', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce(runningRun)
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ get }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(3);

    await assertion;
  });

  it('keeps waiting after a timed out long poll', async () => {
    const waitForTerminalStatus = vi
      .fn()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ waitForTerminalStatus }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitForTerminalStatus).toHaveBeenCalledTimes(2);

    await assertion;
  });

  it('retries the payload read of a completed run', async () => {
    vi.useRealTimers();
    process.env[envName] = '10';
    const output = await dehydrateWorkflowReturnValue(
      { ok: true },
      RUN_ID,
      undefined
    );
    const completedRun = {
      ...baseRun,
      status: 'completed' as const,
      completedAt: new Date(0),
      output,
    };
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowWorldError('Service Unavailable', { status: 503 })
      )
      .mockResolvedValue(completedRun);
    setWorld(
      createWorld({
        get,
        waitForTerminalStatus: vi.fn().mockResolvedValue(completedRun),
      })
    );

    await expect(new Run(RUN_ID).returnValue).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('waits out a 429 for its retryAfter', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ThrottleError('Too Many Requests', { retryAfter: 5 })
      )
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ get }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(get).toHaveBeenCalledTimes(2);

    await assertion;
  });

  it('backs off across consecutive failures and starts over after a good read', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(serverError())
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce(runningRun)
      .mockRejectedValueOnce(serverError())
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ get }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(5);

    await assertion;
  });

  it('still rejects on a permanent World error', async () => {
    const forbidden = new WorkflowWorldError('Forbidden', { status: 403 });
    const get = vi.fn().mockRejectedValue(forbidden);
    setWorld(createWorld({ get }));

    await expect(new Run(RUN_ID).returnValue).rejects.toBe(forbidden);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('still rejects on an error that is not from the World', async () => {
    const bug = new TypeError('boom');
    const get = vi.fn().mockRejectedValue(bug);
    setWorld(createWorld({ get }));

    await expect(new Run(RUN_ID).returnValue).rejects.toBe(bug);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('transientReadRetryDelayMs', () => {
  it('returns undefined for an error that must reach the caller', () => {
    expect(
      transientReadRetryDelayMs(
        new WorkflowWorldError('Not Found', { status: 404 }),
        0,
        1_000
      )
    ).toBeUndefined();
    expect(transientReadRetryDelayMs(new Error('x'), 0, 1_000)).toBeUndefined();
  });

  it('caps the backoff', () => {
    expect(transientReadRetryDelayMs(timedOut(), 3, 1_000)).toBe(8_000);
    expect(transientReadRetryDelayMs(timedOut(), 2_000, 1_000)).toBe(30_000);
    expect(transientReadRetryDelayMs(timedOut(), 2_000, 60_000)).toBe(60_000);
  });

  it('never waits less than the backoff, whatever retryAfter says', () => {
    const throttled = (retryAfter: number) =>
      new ThrottleError('Too Many Requests', { retryAfter });
    expect(transientReadRetryDelayMs(throttled(0), 0, 1_000)).toBe(1_000);
    expect(transientReadRetryDelayMs(throttled(-5), 0, 1_000)).toBe(1_000);
    expect(transientReadRetryDelayMs(throttled(Number.NaN), 0, 1_000)).toBe(
      1_000
    );
    expect(transientReadRetryDelayMs(throttled(1e9), 0, 1_000)).toBe(
      2 ** 31 - 1
    );
  });
});
