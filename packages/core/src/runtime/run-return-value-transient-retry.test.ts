import {
  ThrottleError,
  WorkflowRunCancelledError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { runtimeLogger } from '../logger.js';
import { dehydrateWorkflowReturnValue } from '../serialization.js';
import { Run } from './run.js';
import {
  TRANSIENT_READ_MAX_BACKOFF_MS,
  TRANSIENT_READ_MAX_RETRIES,
  TRANSIENT_READ_MAX_RETRY_AFTER_MS,
  transientReadRetryDelayMs,
} from './transient-read-retry.js';
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
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('does not count a failed long poll toward WORKFLOW_RETURN_VALUE_MAX_LONG_POLLS', async () => {
    const maxLongPolls = 'WORKFLOW_RETURN_VALUE_MAX_LONG_POLLS';
    const previous = process.env[maxLongPolls];
    process.env[maxLongPolls] = '1';
    try {
      const waitForTerminalStatus = vi
        .fn()
        .mockRejectedValueOnce(timedOut())
        .mockResolvedValue(cancelledRun);
      const get = vi.fn().mockResolvedValue(cancelledRun);
      setWorld(createWorld({ get, waitForTerminalStatus }));

      const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
        WorkflowRunCancelledError
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      // The one wait the cap allows is the retry, not a plain read.
      expect(waitForTerminalStatus).toHaveBeenCalledTimes(2);
      expect(get).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[maxLongPolls];
      else process.env[maxLongPolls] = previous;
    }
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

  it('gives up after TRANSIENT_READ_MAX_RETRIES transient failures in a row', async () => {
    const get = vi.fn().mockRejectedValue(serverError());
    setWorld(createWorld({ get }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      'Internal Server Error'
    );

    let totalDelayMs = 0;
    for (let attempt = 0; attempt < TRANSIENT_READ_MAX_RETRIES; attempt++) {
      const delayMs = transientReadRetryDelayMs(serverError(), attempt, 1_000);
      if (delayMs === undefined) throw new Error('expected a retry delay');
      totalDelayMs += delayMs;
    }
    await vi.advanceTimersByTimeAsync(totalDelayMs - 1);
    expect(get).toHaveBeenCalledTimes(TRANSIENT_READ_MAX_RETRIES);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(get).toHaveBeenCalledTimes(TRANSIENT_READ_MAX_RETRIES + 1);
  });

  it('logs each retried error with the run and the delay', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ get }));

    const assertion = expect(new Run(RUN_ID).returnValue).rejects.toThrow(
      WorkflowRunCancelledError
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(runtimeLogger.warn).toHaveBeenCalledOnce();
    expect(runtimeLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowRunId: RUN_ID,
        attempt: 1,
        retryDelayMs: 1_000,
        errorName: 'WorkflowWorldError',
      })
    );
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
    const last = TRANSIENT_READ_MAX_RETRIES - 1;
    expect(transientReadRetryDelayMs(timedOut(), 3, 1_000)).toBe(8_000);
    expect(
      transientReadRetryDelayMs(
        timedOut(),
        last,
        TRANSIENT_READ_MAX_BACKOFF_MS / 2 ** (last - 1)
      )
    ).toBe(TRANSIENT_READ_MAX_BACKOFF_MS);
    // An interval above the cap is used as is, never shortened.
    const longInterval = TRANSIENT_READ_MAX_BACKOFF_MS * 2;
    expect(transientReadRetryDelayMs(timedOut(), last, longInterval)).toBe(
      longInterval
    );
    expect(
      transientReadRetryDelayMs(timedOut(), TRANSIENT_READ_MAX_RETRIES, 1_000)
    ).toBeUndefined();
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
      TRANSIENT_READ_MAX_RETRY_AFTER_MS
    );
  });
});
