import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeWebhook, start } from 'workflow/api';
import {
  fetchWithFallback,
  processWithTimeout,
  waitForApproval,
} from '../workflows/patterns/timeouts.js';

const RUN = Date.now().toString(36);

describe('timeouts pattern', () => {
  describe('hard timeout (processWithTimeout)', () => {
    it('returns the result when work beats the deadline', async () => {
      const run = await start(processWithTimeout, [`fast-${RUN}`]);
      const result = await run.returnValue;
      expect(result).toBe(`FAST-${RUN}`.toUpperCase());
    });

    it('throws when the deadline fires first', async () => {
      // "slow:" inputs make the demo step take 5s of wall-clock time —
      // wake the 30s deadline sleep so the race resolves to TIMEOUT.
      const run = await start(processWithTimeout, [`slow:${RUN}`]);

      const sleepId = await waitForSleep(run);
      await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

      await expect(run.returnValue).rejects.toThrow(
        /Processing timed out after 30 seconds/
      );
    });
  });

  describe('soft timeout (fetchWithFallback)', () => {
    it('returns the fetched value when it beats the deadline', async () => {
      const run = await start(fetchWithFallback, [`key-${RUN}`, 'cached']);
      const result = await run.returnValue;
      expect(result).toBe(`fresh_key-${RUN}`);
    });

    it('falls back to the provided value when the deadline fires first', async () => {
      const run = await start(fetchWithFallback, [`slow:${RUN}`, 'cached']);

      const sleepId = await waitForSleep(run);
      await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

      const result = await run.returnValue;
      expect(result).toBe('cached');
    });
  });

  describe('webhook + deadline (waitForApproval)', () => {
    it('resolves with the approval when the webhook fires in time', async () => {
      const run = await start(waitForApproval, [`req-${RUN}-ok`]);

      const hook = await waitForHook(run);
      await resumeWebhook(
        hook.token,
        new Request('https://example.com/approve', {
          method: 'POST',
          body: JSON.stringify({ approved: true }),
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await run.returnValue;
      expect(result).toBe(true);
    });

    it('throws when the deadline expires before the webhook arrives', async () => {
      const run = await start(waitForApproval, [`req-${RUN}-late`]);

      // Make sure the webhook is registered, then expire the 7-day sleep.
      await waitForHook(run);
      const sleepId = await waitForSleep(run);
      await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

      await expect(run.returnValue).rejects.toThrow(
        /Approval request expired after 7 days/
      );
    });
  });
});
