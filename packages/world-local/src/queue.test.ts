import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setWorkflowBasePath } from '@workflow/utils';
import type { StepInvokePayload } from '@workflow/world';
import { MessageId, NODE_HTTP_ENV_VAR, ValidQueueName } from '@workflow/world';
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

// The suite below covers the queue on undici, including the tests that stub
// the global `fetch`. `WORKFLOW_NODE_HTTP` sends deliveries over `node:http`
// instead, where stubbing `fetch` proves nothing, so pin the flag off rather
// than tracking whichever way its default points. That mode has its own
// describe at the end.
beforeEach(() => {
  vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe('queue shutdown', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      const toClose = server;
      server = undefined;
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
    vi.restoreAllMocks();
  });

  it('aborts an in-flight delivery when the queue closes', async () => {
    let requestReceived = false;
    server = createServer(() => {
      requestReceived = true;
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    const localQueue = createQueue({
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await localQueue.queue('__wkf_step_test' as any, stepPayload);
    await vi.waitFor(() => expect(requestReceived).toBe(true));
    const closePromise = localQueue.close();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), 1_000);
      }),
    ]);
    clearTimeout(timeout);
    if (outcome === 'timed-out') {
      server.closeAllConnections();
      await closePromise;
    }
    expect(outcome).toBe('closed');
  });
});

describe('node:http mode', () => {
  let server: Server | undefined;

  beforeEach(() => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '1');
  });

  afterEach(async () => {
    if (server !== undefined) {
      const toClose = server;
      server = undefined;
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The equivalence claim the flag makes: a delivery still goes out, still
  // carries the VQS headers the handler reads, and still lands on the handler.
  // The global `fetch` is stubbed to throw to prove the request left undici
  // entirely rather than falling back to the runtime's own pool.
  it('delivers without going through fetch', async () => {
    const attempts: (string | undefined)[] = [];
    server = createServer((request, response) => {
      attempts.push(request.headers['x-vqs-message-attempt'] as string);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch must not be used under WORKFLOW_NODE_HTTP');
      })
    );

    const localQueue = createQueue({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      await localQueue.queue('__wkf_step_test' as any, stepPayload);
      await vi.waitFor(() => expect(attempts.length).toBe(1), {
        timeout: 5_000,
      });
      expect(attempts[0]).toBe('1');
    } finally {
      await localQueue.close();
    }
  });

  // close() owns a socket pool here too, just Node's rather than undici's. It
  // still has to settle, and it still has to tolerate being called twice from
  // the shutdown paths (CLI signal handlers, test teardown).
  it('closes idempotently', async () => {
    const localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    await expect(localQueue.close()).resolves.toBeUndefined();
    await expect(localQueue.close()).resolves.toBeUndefined();
  });
});
