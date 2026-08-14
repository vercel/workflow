import { WorkflowRunCancelledError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { dehydrateWorkflowReturnValue } from '../serialization.js';
import {
  getReturnValueWaitTimeoutMs,
  isReturnValueLongPollEnabled,
  Run,
} from './run.js';
import { setWorld } from './world.js';

/**
 * `await run.returnValue` and the World's optional long poll
 * (`runs.waitForTerminalStatus`).
 *
 * The behavior being pinned down here is the *pacing*, not the values: which
 * read the runtime issues, and how long it waits between two non-terminal
 * observations. All of it runs on fake timers so the assertions are about the
 * scheduling itself rather than wall-clock luck.
 */

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

/** Resolve after `ms` on the *fake* clock. */
const sleepFake = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Run.returnValue long poll', () => {
  const envNames = [
    'WORKFLOW_RETURN_VALUE_LONG_POLL',
    'WORKFLOW_RETURN_VALUE_WAIT_MS',
    'WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS',
  ] as const;
  const originalEnv = new Map(
    envNames.map((name) => [name, process.env[name]])
  );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setWorld(undefined as unknown as World);
  });

  it('waits on the World long poll instead of polling runs.get', async () => {
    const waitForTerminalStatus = vi.fn().mockResolvedValue(cancelledRun);
    const world = createWorld({ waitForTerminalStatus });
    setWorld(world);

    await expect(new Run(RUN_ID).returnValue).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    expect(waitForTerminalStatus).toHaveBeenCalledTimes(1);
    expect(waitForTerminalStatus).toHaveBeenCalledWith(RUN_ID, {
      timeoutMs: getReturnValueWaitTimeoutMs(),
    });
    // The status read went through the long poll — no interval poll happened.
    expect(world.runs.get).not.toHaveBeenCalled();
  });

  it('forwards the configured wait budget', async () => {
    process.env.WORKFLOW_RETURN_VALUE_WAIT_MS = '3000';
    const waitForTerminalStatus = vi.fn().mockResolvedValue(cancelledRun);
    setWorld(createWorld({ waitForTerminalStatus }));

    await expect(new Run(RUN_ID).returnValue).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    expect(waitForTerminalStatus).toHaveBeenCalledWith(RUN_ID, {
      timeoutMs: 3_000,
    });
  });

  it('resolves the hydrated return value from a completed long poll', async () => {
    vi.useRealTimers();
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
    const waitForTerminalStatus = vi.fn().mockResolvedValue(completedRun);
    setWorld(
      createWorld({
        waitForTerminalStatus,
        get: vi.fn().mockResolvedValue(completedRun),
      })
    );

    await expect(new Run(RUN_ID).returnValue).resolves.toEqual({ ok: true });
  });

  it('paces a World whose wait returns a non-terminal run early', async () => {
    // A World that cannot actually hold the wait open (e.g. world-vercel
    // talking to a server without the long-poll route) answers immediately
    // with a non-terminal run. The loop must fall back to interval polling
    // rather than spinning on it.
    process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS = '1000';
    const waitForTerminalStatus = vi
      .fn()
      .mockResolvedValueOnce(runningRun)
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ waitForTerminalStatus }));

    const pending = new Run(RUN_ID).returnValue;
    const assertion = expect(pending).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(waitForTerminalStatus).toHaveBeenCalledTimes(1);

    // Still inside the interval — no second attempt yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(waitForTerminalStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(waitForTerminalStatus).toHaveBeenCalledTimes(2);

    await assertion;
  });

  it('does not add an interval sleep when the wait already outlasted it', async () => {
    // The whole point of the long poll: a wait that blocked for longer than
    // the poll interval re-issues immediately instead of sleeping again.
    process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS = '1000';
    const waitForTerminalStatus = vi
      .fn()
      .mockImplementationOnce(async () => {
        await sleepFake(1_500);
        return runningRun;
      })
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ waitForTerminalStatus }));

    const pending = new Run(RUN_ID).returnValue;
    const assertion = expect(pending).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(1_500);
    expect(waitForTerminalStatus).toHaveBeenCalledTimes(2);

    await assertion;
  });

  it('interval-polls runs.get when the World has no long poll', async () => {
    process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS = '1000';
    const get = vi
      .fn()
      .mockResolvedValueOnce(runningRun)
      .mockResolvedValue(cancelledRun);
    const world = createWorld({ get });
    setWorld(world);

    const pending = new Run(RUN_ID).returnValue;
    const assertion = expect(pending).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(2);

    await assertion;
  });

  it('kill switch restores the fixed-interval poll', async () => {
    process.env.WORKFLOW_RETURN_VALUE_LONG_POLL = '0';
    process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS = '1000';
    const waitForTerminalStatus = vi.fn().mockResolvedValue(cancelledRun);
    const get = vi
      .fn()
      .mockResolvedValueOnce(runningRun)
      .mockResolvedValue(cancelledRun);
    setWorld(createWorld({ get, waitForTerminalStatus }));

    const pending = new Run(RUN_ID).returnValue;
    const assertion = expect(pending).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(waitForTerminalStatus).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('isReturnValueLongPollEnabled', () => {
  const envName = 'WORKFLOW_RETURN_VALUE_LONG_POLL';
  const originalValue = process.env[envName];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[envName];
    else process.env[envName] = originalValue;
  });

  it('defaults to on', () => {
    delete process.env[envName];
    expect(isReturnValueLongPollEnabled()).toBe(true);
  });

  it('treats an empty value as unset', () => {
    process.env[envName] = '';
    expect(isReturnValueLongPollEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'FALSE'])('is disabled by %s', (value) => {
    process.env[envName] = value;
    expect(isReturnValueLongPollEnabled()).toBe(false);
  });

  it.each(['1', 'true'])('stays enabled for %s', (value) => {
    process.env[envName] = value;
    expect(isReturnValueLongPollEnabled()).toBe(true);
  });
});

describe('getReturnValueWaitTimeoutMs', () => {
  const envName = 'WORKFLOW_RETURN_VALUE_WAIT_MS';
  const originalValue = process.env[envName];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[envName];
    else process.env[envName] = originalValue;
  });

  it('defaults to a budget under the adapter request timeout', () => {
    delete process.env[envName];
    expect(getReturnValueWaitTimeoutMs()).toBe(25_000);
  });

  it('accepts a runtime override', () => {
    process.env[envName] = '5000';
    expect(getReturnValueWaitTimeoutMs()).toBe(5_000);
  });
});
