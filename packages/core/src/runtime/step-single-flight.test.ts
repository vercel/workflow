import { withResolvers } from '@workflow/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepExecutionResult } from './step-executor.js';
import {
  runStepSingleFlight,
  STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
} from './step-single-flight.js';

const RUN = 'wrun_00000000000000000000000000';
const STEP = 'step_00000000000000000000000000';

describe('runStepSingleFlight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { logLevel: undefined, debug: '', expected: 'warn' },
    { logLevel: 'debug', debug: '', expected: undefined },
    { logLevel: 'debug', debug: 'workflow:runtime:debug', expected: 'debug' },
  ] as const)('logs contention at $logLevel with DEBUG=$debug', async ({
    logLevel,
    debug,
    expected,
  }) => {
    vi.stubEnv('DEBUG', debug);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugLog = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { promise, resolve } = withResolvers<StepExecutionResult>();
    const execute = vi.fn(() => promise);
    const winner = runStepSingleFlight(RUN, STEP, execute, logLevel);
    const contender = runStepSingleFlight(RUN, STEP, execute, logLevel);

    resolve({ type: 'completed', result: {} } as StepExecutionResult);
    await expect(winner).resolves.toEqual({ type: 'completed', result: {} });
    await expect(contender).resolves.toEqual({
      type: 'throttled',
      timeoutSeconds: STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(expected === 'warn' ? 1 : 0);
    expect(debugLog).toHaveBeenCalledTimes(expected === 'debug' ? 1 : 0);
    if (expected === 'warn') {
      expect(warn.mock.calls[0][0]).toContain(RUN);
      expect(warn.mock.calls[0][0]).toContain(STEP);
    } else if (expected === 'debug') {
      expect(debugLog).toHaveBeenCalledWith(
        expect.stringContaining('Step execution already in flight'),
        { workflowRunId: RUN, stepId: STEP }
      );
    }
  });

  it('executes when nothing is in flight and returns the result', async () => {
    let calls = 0;
    const result = await runStepSingleFlight(RUN, STEP, async () => {
      calls++;
      return { type: 'completed', result: {} } as StepExecutionResult;
    });
    expect(result).toEqual({ type: 'completed', result: {} });
    expect(calls).toBe(1);
  });

  it.each([
    undefined,
    'debug',
  ] as const)('a concurrent second caller waits for settlement (log level %s)', async (logLevel) => {
    const { promise, resolve } = withResolvers<StepExecutionResult>();
    let loserCalls = 0;

    const winner = runStepSingleFlight(RUN, STEP, () => promise, logLevel);
    const loser = runStepSingleFlight(
      RUN,
      STEP,
      async () => {
        loserCalls++;
        return { type: 'completed' };
      },
      logLevel
    );

    // The loser must not resolve (ack) before the winner settles — an early
    // ack could orphan the step if the process crashed mid-winner.
    let loserSettled = false;
    loser.then(() => {
      loserSettled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(loserSettled).toBe(false);
    expect(loserCalls).toBe(0);

    resolve({ type: 'completed', result: {} } as StepExecutionResult);
    expect(await winner).toEqual({ type: 'completed', result: {} });
    expect(await loser).toEqual({
      type: 'throttled',
      timeoutSeconds: STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
    });
    expect(loserCalls).toBe(0);
  });

  it.each([
    undefined,
    'debug',
  ] as const)('a loser skips when the winner rejects (log level %s)', async (logLevel) => {
    const { promise, reject } = withResolvers<StepExecutionResult>();
    const winner = runStepSingleFlight(RUN, STEP, () => promise, logLevel);
    const loser = runStepSingleFlight(
      RUN,
      STEP,
      async () => ({
        type: 'completed',
      }),
      logLevel
    );

    reject(new Error('transient world error'));
    await expect(winner).rejects.toThrow('transient world error');
    // The winner's own queue message redelivers and owns the retry; the
    // loser just acks without executing.
    expect(await loser).toEqual({
      type: 'throttled',
      timeoutSeconds: STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
    });
  });

  it('releases the slot after settlement so later executions run again', async () => {
    let calls = 0;
    const run = () =>
      runStepSingleFlight(RUN, STEP, async () => {
        calls++;
        return { type: 'completed', result: {} } as StepExecutionResult;
      });
    await run();
    await run();
    expect(calls).toBe(2);
  });

  it('keys by runId AND correlationId — different steps do not collide', async () => {
    const { promise, resolve } = withResolvers<StepExecutionResult>();
    let otherCalls = 0;

    const first = runStepSingleFlight(RUN, STEP, () => promise);
    const other = await runStepSingleFlight(
      RUN,
      'step_00000000000000000000000001',
      async () => {
        otherCalls++;
        return { type: 'completed', result: {} } as StepExecutionResult;
      }
    );
    expect(other).toEqual({ type: 'completed', result: {} });
    expect(otherCalls).toBe(1);

    resolve({ type: 'completed', result: {} } as StepExecutionResult);
    await first;
  });
});
