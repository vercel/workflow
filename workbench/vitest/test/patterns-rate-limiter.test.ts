// TODO(skipped): dead-waiter skip (a queued grant whose waiter disposed its
// hook must not consume an interval) — forcing that race deterministically
// would require pausing the coordinator between resume and grant, which
// isn't observable from outside. Covered implicitly by grantSlot's catch.
import { afterAll, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  cancelCoordinator,
  rateLimitCaller,
  rateLimitInRunFanout,
  readRateLimitStats,
  resetRateLimitStats,
} from '../workflows/drivers/rate-limiter-drivers.js';

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  fanout: `rl-fanout-${RUN}`,
  inRun: `rl-in-run-${RUN}`,
};

const COUNT = 4;
const INTERVAL_MS = 300;

// Grants are spaced: the coordinator sleeps intervalMs between grants.
// Timestamps are recorded when each waiter's fn starts (just after its
// grant arrives), so allow a small scheduling-jitter tolerance — the sleep
// itself guarantees >= intervalMs between the grant *sends*.
function expectSpacedGrants(result: { results: number[]; times: number[] }) {
  // Every caller got a slot and ran its fn.
  expect([...result.results].sort()).toEqual([0, 1, 2, 3]);
  expect(result.times).toHaveLength(COUNT);

  const times = [...result.times].sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(INTERVAL_MS - 50);
  }
  // And the whole batch took at least (N-1) intervals.
  expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(
    (COUNT - 1) * (INTERVAL_MS - 50)
  );
}

describe('rate-limiter', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`rate-limiter:${key}`);
    }
  });

  it('completes N concurrent calls with grants spaced by intervalMs', async () => {
    // Callers are separate runs — the limiter's contract is cluster-wide,
    // and the recorded times live in the step bundle's module scope.
    await (await start(resetRateLimitStats, [])).returnValue;

    const callers = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        start(rateLimitCaller, [KEYS.fanout, INTERVAL_MS, i])
      )
    );
    const results = await Promise.all(callers.map((run) => run.returnValue));
    const times = await (await start(readRateLimitStats, [])).returnValue;

    expectSpacedGrants({ results, times });
  });

  // Same pacing, but the callers are concurrent calls inside ONE run. This
  // is the shape that trips replay divergence if withRateLimit() lets its
  // hook and retry timer be allocated in step-completion order instead of
  // call order.
  it('spaces grants across concurrent calls in one run', async () => {
    const run = await start(rateLimitInRunFanout, [
      KEYS.inRun,
      COUNT,
      INTERVAL_MS,
    ]);

    expectSpacedGrants(await run.returnValue);
  });
});
