import { waitForSleep } from '@workflow/vitest';
import { afterAll, describe, expect, it } from 'vitest';
import { getRun } from 'workflow/api';
import { KillSwitch } from '../workflows/patterns/kill-switch.js';

// Unique ids per vitest invocation — the local world persists across runs.
const RUN = Date.now().toString(36);

/** Await an AbortSignal firing, with a timeout so a dead signal fails fast. */
function abortedReason(
  signal: AbortSignal,
  timeoutMs = 15_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(signal.reason);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`signal did not fire within ${timeoutMs}ms`)),
      timeoutMs
    );
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(signal.reason);
    });
  });
}

describe('kill-switch', () => {
  const runIds: string[] = [];

  afterAll(async () => {
    // Cancel any controller runs still sleeping on their 24h TTL.
    for (const runId of runIds) {
      await getRun(runId)
        .cancel()
        .catch(() => {});
    }
  });

  it('abort from elsewhere fires .signal with the reason', async () => {
    const id = `ks-abort-${RUN}`;
    const sw = await KillSwitch.create(id);
    runIds.push(sw.runId);

    const signal = sw.signal;
    expect(signal.aborted).toBe(false);

    // "Elsewhere": an independent handle derived from the same semantic id
    // (no runId sharing) — as another process or machine would do it.
    const elsewhere = await KillSwitch.create(id);
    expect(elsewhere.runId).toBe(sw.runId);
    await elsewhere.abort('user clicked cancel');

    const reason = await abortedReason(signal);
    expect(reason).toBe('user clicked cancel');

    const result = await getRun(sw.runId).returnValue;
    expect(result).toEqual({
      aborted: true,
      reason: 'user clicked cancel',
      expired: false,
    });
  });

  it('create() twice with the same id returns handles to the same run', async () => {
    const id = `ks-same-${RUN}`;
    const first = await KillSwitch.create(id);
    runIds.push(first.runId);
    const second = await KillSwitch.create(id);
    runIds.push(second.runId);

    expect(second.runId).toBe(first.runId);
  });

  it('abort() is idempotent — a second abort does not throw', async () => {
    const id = `ks-idem-${RUN}`;
    const sw = await KillSwitch.create(id);
    runIds.push(sw.runId);

    await sw.abort('first');
    const result = await getRun(sw.runId).returnValue;
    expect(result.reason).toBe('first');

    // Second abort after the controller already fired (and its run
    // completed) must be a no-op, not an error.
    await expect(sw.abort('second')).resolves.toBeUndefined();
  });

  // TTL expiry without waiting 24h: force-wake the TTL sleep (and the grace
  // sleep) instead of shrinking the production constants.
  it('TTL expiry aborts the signal with "(expired)" suffix', async () => {
    const id = `ks-ttl-${RUN}`;
    const sw = await KillSwitch.create(id);
    runIds.push(sw.runId);

    const signal = sw.signal;
    const run = getRun(sw.runId);

    // Wake the 24h TTL sleep — the hook race resolves to the expired branch.
    const ttlSleep = await waitForSleep(run);
    await run.wakeUp({ correlationIds: [ttlSleep] });

    const reason = await abortedReason(signal);
    expect(reason).toBe('Controller expired (expired)');

    // The run now sleeps through the grace period — wake that too.
    const graceSleep = await waitForSleep(run);
    await run.wakeUp({ correlationIds: [graceSleep] });

    const result = await run.returnValue;
    expect(result).toEqual({
      aborted: true,
      reason: 'Controller expired',
      expired: true,
    });
  });
});
