/**
 * Cookbook: stop-workflow pattern
 *
 * Demonstrates using a defineHook as a stop signal to break out of
 * a workflow loop gracefully.
 */
import { defineHook } from 'workflow';

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

  let stopRequested = false;
  let stopReason: string | undefined;

  const hook = stopHook.create({ token: stopToken });
  hook.then(({ reason }) => {
    stopRequested = true;
    stopReason = reason;
  });

  const results: Array<{ iteration: number; result: string }> = [];

  for (let i = 0; i < maxIterations; i++) {
    if (stopRequested) break;
    const work = await doWork(i);
    results.push(work);
  }

  return {
    completed: results.length,
    stopped: stopRequested,
    stopReason,
    results,
  };
}
