import type { StepInvokePayload } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from './queue';

const stepPayload: StepInvokePayload = {
  workflowName: 'test-workflow',
  workflowRunId: 'run_01ABC',
  workflowStartedAt: Date.now(),
  stepId: 'step_01ABC',
};

describe('queue timeout re-enqueue', () => {
  const maxSetTimeoutDelayMs = 2_147_483_647;
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    vi.useFakeTimers();
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.useRealTimers();
  });

  it('createQueueHandler returns 200 with timeoutSeconds in the body', async () => {
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => ({
      timeoutSeconds: 30,
    }));

    const req = new Request('http://localhost/step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_step_test',
        'x-vqs-message-id': 'msg_01ABC',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify(stepPayload),
    });

    const response = await handler(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ timeoutSeconds: 30 });
  });

  it('createQueueHandler returns 200 with ok:true when no timeout', async () => {
    const handler = localQueue.createQueueHandler(
      '__wkf_step_',
      async () => undefined
    );

    const req = new Request('http://localhost/step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_step_test',
        'x-vqs-message-id': 'msg_01ABC',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify(stepPayload),
    });

    const response = await handler(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });

  it('queue retries when handler returns timeoutSeconds > 0', async () => {
    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      if (callCount < 3) {
        return { timeoutSeconds: 5 };
      }
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload);
    await vi.runAllTimersAsync();

    expect(callCount).toBe(3);
  });

  it('queue retries immediately when handler returns timeoutSeconds: 0', async () => {
    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      if (callCount < 3) {
        return { timeoutSeconds: 0 };
      }
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload);
    await vi.runAllTimersAsync();

    expect(callCount).toBe(3);
  });

  it('replaces delayed idempotent deliveries with an immediate wake-up', async () => {
    const seenStepIds: string[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_step_',
      async (body) => {
        seenStepIds.push((body as StepInvokePayload).stepId);
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      idempotencyKey: 'step_01ABC',
      delaySeconds: 30,
    });
    await localQueue.queue(
      '__wkf_step_test' as any,
      { ...stepPayload, stepId: 'step_replacement' },
      {
        idempotencyKey: 'step_01ABC',
      }
    );

    await vi.runAllTimersAsync();

    expect(seenStepIds).toEqual(['step_replacement']);
  });

  it('does not fire long delayed messages before the setTimeout max delay elapses', async () => {
    let callCount = 0;
    const delaySeconds = Math.ceil((maxSetTimeoutDelayMs + 5_000) / 1000);
    const remainingDelayMs = delaySeconds * 1000 - maxSetTimeoutDelayMs;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      delaySeconds,
    });

    await vi.advanceTimersByTimeAsync(maxSetTimeoutDelayMs);
    expect(callCount).toBe(0);

    await vi.advanceTimersByTimeAsync(remainingDelayMs);
    expect(callCount).toBe(1);
  });

  it('replaces chunked long-delay deliveries with an immediate idempotent wake-up', async () => {
    const seenStepIds: string[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_step_',
      async (body) => {
        seenStepIds.push((body as StepInvokePayload).stepId);
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      idempotencyKey: 'step_very_delayed',
      delaySeconds: Math.ceil((maxSetTimeoutDelayMs + 5_000) / 1000),
    });
    await localQueue.queue(
      '__wkf_step_test' as any,
      { ...stepPayload, stepId: 'step_immediate_replacement' },
      {
        idempotencyKey: 'step_very_delayed',
      }
    );

    await vi.runAllTimersAsync();

    expect(seenStepIds).toEqual(['step_immediate_replacement']);
  });
});
