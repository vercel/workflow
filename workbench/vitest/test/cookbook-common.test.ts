import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, start } from 'workflow/api';
import { fanOutWorkflow } from '../workflows/cookbook/fan-out.js';
import { contentRouterWorkflow } from '../workflows/cookbook/content-router.js';
import {
  DistributedAbortController,
  abortControllerWorkflow,
  abortHook,
} from '../workflows/cookbook/distributed-abort-controller.js';

describe('fan-out', () => {
  it('should notify multiple channels in parallel', async () => {
    const run = await start(fanOutWorkflow, ['inc-1', 'Server down']);
    const result = await run.returnValue;
    expect(result).toEqual({ incidentId: 'inc-1', delivered: 3, failed: 0 });
  });
});

describe('content-router', () => {
  it('should route billing tickets to billing handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-1', 'Invoice issue']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-1',
      routedTo: 'billing',
      result: 'handled-billing',
    });
  });

  it('should route technical tickets to technical handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-2', 'Bug in dashboard']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-2',
      routedTo: 'technical',
      result: 'handled-technical',
    });
  });

  it('should route unknown tickets to general handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-3', 'Hello there']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-3',
      routedTo: 'general',
      result: 'handled-general',
    });
  });
});

describe('distributed-abort-controller', () => {
  const TTL_MS = 5 * 60 * 1000;
  const GRACE_MS = 60 * 1000;

  it('should abort via hook and emit message on stream', async () => {
    const testId = `test-${Date.now()}`;

    const run = await start(abortControllerWorkflow, [
      testId,
      TTL_MS,
      GRACE_MS,
    ]);

    const hook = await waitForHook(run);
    expect(hook.token).toBe(`abort:${testId}`);

    await abortHook.resume(`abort:${testId}`, { reason: 'User cancelled' });

    const result = await run.returnValue;
    expect(result).toEqual({
      aborted: true,
      reason: 'User cancelled',
      expired: false,
    });
  });

  it('should emit abort message on the readable stream', async () => {
    const testId = `stream-test-${Date.now()}`;

    const run = await start(abortControllerWorkflow, [
      testId,
      TTL_MS,
      GRACE_MS,
    ]);

    const readable = run.getReadable<{ type: string; reason?: string }>();
    const reader = readable.getReader();

    await waitForHook(run);
    await abortHook.resume(`abort:${testId}`, { reason: 'Stream test' });

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual({
      type: 'abort',
      reason: 'Stream test',
      expired: false,
    });

    reader.releaseLock();

    const result = await run.returnValue;
    expect(result.aborted).toBe(true);
  });

  it('should work with DistributedAbortController instance', async () => {
    const testId = `signal-test-${Date.now()}`;

    const controller = await DistributedAbortController.create(testId, {
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
    });

    const signal = controller.signal;
    expect(signal.aborted).toBe(false);

    const abortPromise = new Promise<string | undefined>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(signal.reason as string | undefined);
      });
    });

    // Wait for the workflow to register the hook before resuming it
    await waitForHook(getRun(controller.runId));

    await controller.abort('Signal test reason');

    const reason = await abortPromise;
    expect(reason).toBe('Signal test reason');
    expect(signal.aborted).toBe(true);
  });
});
