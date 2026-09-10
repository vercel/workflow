import { waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import type { Run } from 'workflow/api';
import { getRun, start } from 'workflow/api';
import {
  PollTimeoutError,
  waitForCondition,
} from '../workflows/patterns/polling.js';

// Unique target per vitest invocation — the demo check counter is keyed by
// target, and the local world persists across runs.
const RUN = Date.now().toString(36);

/**
 * Wake the next not-yet-woken sleep. waitForSleep returns the first pending
 * sleep; right after a wakeUp the completed event may not be visible yet, so
 * skip correlation IDs we already woke.
 */
async function wakeNextSleep(
  run: Run<unknown>,
  woken: Set<string>
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sleepId = await waitForSleep(run);
    if (!woken.has(sleepId)) {
      woken.add(sleepId);
      await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
      return sleepId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for a new pending sleep');
}

describe('polling pattern', () => {
  it('polls until the condition is ready (3rd check), sleeping between polls', async () => {
    const target = `deploy-${RUN}`;
    const run = await start(waitForCondition, [target]);

    // The demo condition becomes ready on the 3rd check → exactly two
    // backoff sleeps stand between start and completion.
    const woken = new Set<string>();
    await wakeNextSleep(run, woken);
    await wakeNextSleep(run, woken);

    const result = await run.returnValue;
    expect(result.target).toBe(target);
    expect(result.value).toEqual({ state: 'ready', checks: 3 });
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(woken.size).toBe(2);
  });

  it('PollTimeoutError identifies the target it gave up on', () => {
    // The deadline branch needs DEADLINE_MS (24h) of wall-clock time to
    // elapse — Date.now() advances in real time even across wakeUp()s, so
    // the timeout path can't be reached in a test without shrinking
    // production constants (forbidden). Cover the error contract instead.
    const error = new PollTimeoutError('export-42');
    expect(error.name).toBe('PollTimeoutError');
    expect(error.message).toBe('Timed out waiting for "export-42"');
    expect(error).toBeInstanceOf(Error);
  });
});
