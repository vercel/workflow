import { setWorkflowBasePath } from '@workflow/utils';
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
    setWorkflowBasePath(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('routes namespaced queues to namespaced direct handlers', async () => {
    const handlerImpl = vi.fn(
      async (_message: unknown, metadata: { queueName: string }) => {
        expect(metadata.queueName).toBe('__custom_wkf_step_test');
        return undefined;
      }
    );
    const handler = localQueue.createQueueHandler(
      '__custom_wkf_step_',
      handlerImpl
    );

    localQueue.registerHandler('__custom_wkf_step_', handler);

    await localQueue.queue('__custom_wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => {
      expect(handlerImpl).toHaveBeenCalledTimes(1);
    });
  });

  it('uses basePath when delivering to direct in-process handlers', async () => {
    await localQueue.close();
    localQueue = createQueue({});
    setWorkflowBasePath('/v2');
    const handler = vi.fn(async () => Response.json({ ok: true }));

    localQueue.registerHandler('__wkf_step_', handler);
    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    expect(handler.mock.calls[0]?.[0].url).toBe(
      'http://localhost/v2/.well-known/workflow/v1/step'
    );
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

  it('logs actionable guidance for detached ArrayBuffer proxy failures', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const fetchError = new TypeError('fetch failed');
    (fetchError as TypeError & { cause?: unknown }).cause = new TypeError(
      'Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer'
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          '[local world] Queue operation failed: detected "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer"'
        ),
        expect.objectContaining({
          queueName: '__wkf_step_test',
          runId: 'run_01ABC',
          stepId: 'step_01ABC',
          originalError: fetchError,
        })
      );
    });
  });
});

describe('queue delaySeconds', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
  });

  it('honors delaySeconds before delivering the message', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();

    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      delaySeconds: 7,
    });

    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // setTimeout should have been called with the delay (7s = 7000ms)
    // before the message was delivered, cancellable on close().
    expect(mockSetTimeout).toHaveBeenCalledWith(7000, undefined, {
      signal: expect.any(AbortSignal),
    });
  });

  it('close() aborts a pending delayed message without delivering it', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();
    // Real-ish sleep: never resolves, rejects with AbortError on signal
    // abort — mirrors node:timers/promises semantics for long delays.
    vi.mocked(mockSetTimeout).mockImplementationOnce(
      (_delay?: number, _value?: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }) as never
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      delaySeconds: 3600,
    });

    await localQueue.close();
    // Give the aborted delivery promise a chance to settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(callCount).toBe(0);
    // The AbortError must be swallowed silently — no spurious
    // "[local world] Queue operation failed" noise on shutdown.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not call setTimeout for delaySeconds: 0', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();

    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload, {
      delaySeconds: 0,
    });

    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // setTimeout should NOT have been called for delaySeconds: 0 (the
    // delay-honoring branch is gated on `delaySeconds > 0`).
    expect(mockSetTimeout).not.toHaveBeenCalled();
  });

  it('does not call setTimeout when delaySeconds is omitted', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();

    let callCount = 0;
    const handler = localQueue.createQueueHandler('__wkf_step_', async () => {
      callCount++;
      return undefined;
    });

    localQueue.registerHandler('__wkf_step_', handler);

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    expect(mockSetTimeout).not.toHaveBeenCalled();
  });
});

/** undici's shape for a saturated-local-server connect timeout. */
function fetchFailedTimeout(): TypeError {
  const err = new TypeError('fetch failed');
  (err as TypeError & { cause?: unknown }).cause = new AggregateError(
    [
      Object.assign(new Error('connect ETIMEDOUT ::1:3000'), {
        code: 'ETIMEDOUT',
      }),
    ],
    ''
  );
  return err;
}

describe('transport-level delivery failures are retried (regression)', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries an HTTP 500 and recovers (control: non-ok response path)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response('boom', { status: 500 });
        return Response.json({ ok: true }, { status: 200 });
      })
    );

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => expect(calls).toBe(3));
  });

  it('retries a "fetch failed"/ETIMEDOUT transport throw instead of dropping it', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw fetchFailedTimeout();
        return Response.json({ ok: true }, { status: 200 });
      })
    );

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    // Before the fix this stayed at 1 (the throw escaped the retry loop and the
    // message was dropped); now it retries until the transient timeout clears.
    await vi.waitFor(() => expect(calls).toBe(3));
  });

  it('does NOT advance the handler delivery attempt across transport failures', async () => {
    // The handler counts x-vqs-message-attempt against MAX_QUEUE_DELIVERIES, so
    // a burst of transport timeouts must not inflate it: the first delivery that
    // actually reaches the handler must arrive as attempt 1.
    const attempts: number[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        calls++;
        if (calls < 4) throw fetchFailedTimeout();
        attempts.push(Number(init.headers['x-vqs-message-attempt']));
        return Response.json({ ok: true }, { status: 200 });
      })
    );

    await localQueue.queue('__wkf_step_test' as any, stepPayload);

    await vi.waitFor(() => expect(attempts.length).toBe(1));
    expect(attempts[0]).toBe(1);
  });
});
