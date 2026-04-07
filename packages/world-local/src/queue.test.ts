import type { StepInvokePayload } from '@workflow/world';
import { MessageId, ValidQueueName } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { createQueue } from './queue';

// Mock node:timers/promises so setTimeout resolves immediately
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const stepPayload: StepInvokePayload = {
  workflowName: 'test-workflow',
  workflowRunId: 'run_01ABC',
  workflowStartedAt: Date.now(),
  stepId: 'step_01ABC',
};

describe('zod v3/v4 schema compatibility (regression #1587)', () => {
  it('ValidQueueName and MessageId from @workflow/world parse correctly in z.object()', () => {
    const HeaderParser = z.object({
      'x-vqs-queue-name': ValidQueueName,
      'x-vqs-message-id': MessageId,
      'x-vqs-message-attempt': z.coerce.number(),
    });

    const result = HeaderParser.safeParse({
      'x-vqs-queue-name': '__wkf_workflow_test',
      'x-vqs-message-id': 'msg_01ABC',
      'x-vqs-message-attempt': '1',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['x-vqs-queue-name']).toBe('__wkf_workflow_test');
      expect(result.data['x-vqs-message-id']).toBe('msg_01ABC');
      expect(result.data['x-vqs-message-attempt']).toBe(1);
    }
  });
});

describe('queue timeout re-enqueue', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
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

  it('createQueueHandler returns 200 with timeoutSeconds: 0', async () => {
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => ({
      timeoutSeconds: 0,
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
    expect(body).toEqual({ timeoutSeconds: 0 });
  });

  it('queue retries when handler returns timeoutSeconds > 0', async () => {
    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      if (callCount < 3) {
        return { timeoutSeconds: 5 };
      }
      // Third call succeeds normally
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    // Wait for the async queue processing to complete
    // The queue fires off processing asynchronously, so we need to wait
    await vi.waitFor(() => {
      expect(callCount).toBe(3);
    });
  });

  it('queue retries immediately when handler returns timeoutSeconds: 0', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();

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

    await vi.waitFor(() => {
      expect(callCount).toBe(3);
    });

    // setTimeout should NOT have been called for timeoutSeconds: 0
    expect(mockSetTimeout).not.toHaveBeenCalled();
  });
});
