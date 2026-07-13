import { withResolvers } from '@workflow/utils';
import { describe, expect, it } from 'vitest';
import type { StepExecutionResult } from './step-executor.js';
import { runStepSingleFlight } from './step-single-flight.js';

const RUN = 'wrun_00000000000000000000000000';
const STEP = 'step_00000000000000000000000000';

describe('runStepSingleFlight', () => {
  it('executes when nothing is in flight and returns the result', async () => {
    let calls = 0;
    const result = await runStepSingleFlight(RUN, STEP, async () => {
      calls++;
      return { type: 'completed' } satisfies StepExecutionResult;
    });
    expect(result).toEqual({ type: 'completed' });
    expect(calls).toBe(1);
  });

  it('a concurrent second caller does not execute and skips only after the winner settles', async () => {
    const { promise, resolve } = withResolvers<StepExecutionResult>();
    let loserCalls = 0;

    const winner = runStepSingleFlight(RUN, STEP, () => promise);
    const loser = runStepSingleFlight(RUN, STEP, async () => {
      loserCalls++;
      return { type: 'completed' };
    });

    // The loser must not resolve (ack) before the winner settles — an early
    // ack could orphan the step if the process crashed mid-winner.
    let loserSettled = false;
    loser.then(() => {
      loserSettled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(loserSettled).toBe(false);
    expect(loserCalls).toBe(0);

    resolve({ type: 'completed' });
    expect(await winner).toEqual({ type: 'completed' });
    expect(await loser).toEqual({ type: 'skipped' });
    expect(loserCalls).toBe(0);
  });

  it('a loser skips (not throws) when the winner rejects', async () => {
    const { promise, reject } = withResolvers<StepExecutionResult>();
    const winner = runStepSingleFlight(RUN, STEP, () => promise);
    const loser = runStepSingleFlight(RUN, STEP, async () => ({
      type: 'completed',
    }));

    reject(new Error('transient world error'));
    await expect(winner).rejects.toThrow('transient world error');
    // The winner's own queue message redelivers and owns the retry; the
    // loser just acks without executing.
    expect(await loser).toEqual({ type: 'skipped' });
  });

  it('releases the slot after settlement so later executions run again', async () => {
    let calls = 0;
    const run = () =>
      runStepSingleFlight(RUN, STEP, async () => {
        calls++;
        return { type: 'completed' } satisfies StepExecutionResult;
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
        return { type: 'completed' };
      }
    );
    expect(other).toEqual({ type: 'completed' });
    expect(otherCalls).toBe(1);

    resolve({ type: 'completed' });
    await first;
  });
});
