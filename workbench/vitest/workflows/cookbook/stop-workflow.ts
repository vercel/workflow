/**
 * Cookbook: stop-workflow pattern
 *
 * Demonstrates using a defineHook as a stop signal to break out of
 * a workflow loop gracefully.
 */
import { defineHook, sleep } from 'workflow';

export const stopHook = defineHook<{ reason?: string }>();

async function doWork(iteration: number) {
  'use step';
  return { iteration, result: `work-${iteration}` };
}

export async function stopWorkflowDemo(
  maxIterations: number,
  stopToken: string
) {
  'use workflow';

  using hook = stopHook.create({ token: stopToken });
  const stop = hook.then(({ reason }) => ({
    type: 'stop' as const,
    reason,
  }));
  const results: Array<{ iteration: number; result: string }> = [];

  for (let i = 0; i < maxIterations; i++) {
    // Park between iterations so the stop hook remains actionable instead of
    // relying on an external caller to beat a fast sequence of local steps.
    // A scheduler can wake this sleep whenever the next unit of work is ready.
    const signal = await Promise.race([
      stop,
      sleep('1h').then(() => ({ type: 'continue' as const })),
    ]);
    if (signal.type === 'stop') {
      return {
        completed: results.length,
        stopped: true,
        stopReason: signal.reason,
        results,
      };
    }

    results.push(await doWork(i));
  }

  return {
    completed: results.length,
    stopped: false,
    stopReason: undefined,
    results,
  };
}
