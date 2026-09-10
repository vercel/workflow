import { afterAll, describe, expect, it } from 'vitest';
import { getHookByToken, getRun, start } from 'workflow/api';
import {
  cancelCoordinator,
  readDebounceFired,
} from '../workflows/drivers/debounce-drivers.js';
import { debounceSend } from '../workflows/patterns/debounce.js';

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  burst: `deb-burst-${RUN}`,
  reburst: `deb-reburst-${RUN}`,
};

// quietMs is a parameter, not a production constant, so a small real value
// is fine — but it must comfortably exceed worst-case inter-send latency in
// the test environment, or the burst legitimately fires twice (a documented
// caveat of the pattern, not a bug).
const QUIET_MS = 3000;

// Read-only and idempotent, so retried on WorkflowRunNotFoundError: a
// concurrently launched vitest invocation reuses this worker's pool-id tag
// and its setup clear() can delete our in-flight run files.
async function readFiredFor(key: string) {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const read = await start(readDebounceFired, [key]);
      return await read.returnValue;
    } catch (err) {
      if ((err as Error).name !== 'WorkflowRunNotFoundError') throw err;
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastErr;
}

describe('debounce', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`debounce:${key}`);
    }
  });

  it('collapses a burst into one firing with the LATEST payload', async () => {
    // debounceSend is host-callable (it's not a workflow function).
    await debounceSend(KEYS.burst, { v: 1 }, QUIET_MS);
    await debounceSend(KEYS.burst, { v: 2 }, QUIET_MS);
    await debounceSend(KEYS.burst, { v: 3 }, QUIET_MS);

    // Grab the coordinator run while it's alive (hooks are deleted when the
    // owning run completes — the quiet period leaves plenty of room).
    const hook = await getHookByToken(`debounce:${KEYS.burst}`);
    const coordinator = getRun(hook.runId);

    // The coordinator fires once after the quiet period and exits.
    const result = await coordinator.returnValue;
    expect(result).toEqual({ key: KEYS.burst, fired: true });

    const fired = await readFiredFor(KEYS.burst);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({ key: KEYS.burst, payload: { v: 3 } });
  });

  it('a new burst after firing starts a fresh coordinator and fires again', async () => {
    await debounceSend(KEYS.reburst, 'first-burst', QUIET_MS);
    const hook1 = await getHookByToken(`debounce:${KEYS.reburst}`);
    const result1 = await getRun(hook1.runId).returnValue;
    expect(result1).toEqual({ key: KEYS.reburst, fired: true });

    await debounceSend(KEYS.reburst, 'second-burst', QUIET_MS);
    const hook2 = await getHookByToken(`debounce:${KEYS.reburst}`);
    expect(hook2.runId).not.toBe(hook1.runId);
    const result2 = await getRun(hook2.runId).returnValue;
    expect(result2).toEqual({ key: KEYS.reburst, fired: true });

    const fired = await readFiredFor(KEYS.reburst);
    expect(fired).toEqual([
      { key: KEYS.reburst, payload: 'first-burst' },
      { key: KEYS.reburst, payload: 'second-burst' },
    ]);
  });
});
