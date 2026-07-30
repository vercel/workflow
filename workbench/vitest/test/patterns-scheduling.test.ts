import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, start } from 'workflow/api';
import {
  cancellableSleepDriver,
  readExecutedAction,
} from '../workflows/drivers/scheduling-drivers.js';
import {
  cancelSchedule,
  scheduleAction,
} from '../workflows/patterns/scheduling.js';

// Unique ids per vitest invocation — the local world persists across runs.
const RUN = Date.now().toString(36);

describe('scheduling', () => {
  it('cancelSchedule.resume before the delay elapses → status "cancelled"', async () => {
    const id = `sched-cancel-${RUN}`;
    const run = await start(scheduleAction, [
      { id, delay: '1d', payload: { note: 'should never run' } },
    ]);

    // Wait for the cancel hook to register, then cancel by schedule id —
    // the caller never needs the runId.
    await waitForHook(run, { token: `schedule:${id}` });
    await cancelSchedule.resume(`schedule:${id}`, { reason: 'plans changed' });

    const result = await run.returnValue;
    expect(result).toEqual({ id, status: 'cancelled' });

    // The action must NOT have executed.
    const read = await start(readExecutedAction, [id]);
    expect(await read.returnValue).toBeNull();
  });

  it('delay elapses → action executes with the payload → status "executed"', async () => {
    const id = `sched-exec-${RUN}`;
    const payload = { channel: '#alerts', message: 'hello' };
    const run = await start(scheduleAction, [{ id, delay: '1d', payload }]);

    // Force-wake the 1d durable sleep instead of waiting.
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ id, status: 'executed' });

    const read = await start(readExecutedAction, [id]);
    expect(await read.returnValue).toEqual(payload);
  });

  it('cancellableSleep resolves "cancelled" when the hook fires first', async () => {
    const token = `cs-cancel-${RUN}`;
    const run = await start(cancellableSleepDriver, [token, '1d']);

    await waitForHook(run, { token });
    await cancelSchedule.resume(token, { reason: 'cut short' });

    const result = await run.returnValue;
    expect(result).toEqual({ outcome: 'cancelled' });
  });

  it('cancellableSleep resolves "elapsed" when the sleep completes first', async () => {
    const token = `cs-elapsed-${RUN}`;
    const run = await start(cancellableSleepDriver, [token, '1d']);

    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ outcome: 'elapsed' });
  });
});
