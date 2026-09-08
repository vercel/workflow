import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setWorkflowBasePath } from '@workflow/utils';
import type { WorkflowInvokePayload } from '@workflow/world';
import { MessageId, NODE_HTTP_ENV_VAR, ValidQueueName } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  createQueue,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  getQueueAgentOptions,
} from './queue';

// Mock node:timers/promises so setTimeout resolves immediately
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const workflowPayload: WorkflowInvokePayload = {
  runId: 'run_01ABC',
  stepId: 'step_01ABC',
  stepName: 'test-step',
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
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => ({
        timeoutSeconds: 30,
      })
    );

    const req = new Request('http://localhost/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_workflow_test',
        'x-vqs-message-id': 'msg_01ABC',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify(workflowPayload),
    });

    const response = await handler(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ timeoutSeconds: 30 });
  });

  it('createQueueHandler returns 200 with ok:true when no timeout', async () => {
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => undefined
    );

    const req = new Request('http://localhost/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_workflow_test',
        'x-vqs-message-id': 'msg_01ABC',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify(workflowPayload),
    });

    const response = await handler(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });

  it('createQueueHandler returns 200 with timeoutSeconds: 0', async () => {
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => ({
        timeoutSeconds: 0,
      })
    );

    const req = new Request('http://localhost/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_workflow_test',
        'x-vqs-message-id': 'msg_01ABC',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify(workflowPayload),
    });

    const response = await handler(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ timeoutSeconds: 0 });
  });

  it('queue retries when handler returns timeoutSeconds > 0', async () => {
    let callCount = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        if (callCount < 3) {
          return { timeoutSeconds: 5 };
        }
        // Third call succeeds normally
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    // Wait for the async queue processing to complete
    // The queue fires off processing asynchronously, so we need to wait
    await vi.waitFor(() => {
      expect(callCount).toBe(3);
    });
  });

  it('queue retries when the handler rejects', async () => {
    let callCount = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        if (callCount < 3) throw new Error('retry delivery');
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);
    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    await vi.waitFor(() => {
      expect(callCount).toBe(3);
    });
  });

  it('routes namespaced queues to namespaced direct handlers', async () => {
    const handlerImpl = vi.fn(
      async (_message: unknown, metadata: { queueName: string }) => {
        expect(metadata.queueName).toBe('__custom_wkf_workflow_test');
        return undefined;
      }
    );
    const handler = localQueue.createQueueHandler(
      '__custom_wkf_workflow_',
      handlerImpl
    );

    localQueue.registerHandler('__custom_wkf_workflow_', handler);

    await localQueue.queue(
      '__custom_wkf_workflow_test' as any,
      workflowPayload
    );

    await vi.waitFor(() => {
      expect(handlerImpl).toHaveBeenCalledTimes(1);
    });
  });

  it('uses basePath when delivering to direct in-process handlers', async () => {
    await localQueue.close();
    localQueue = createQueue({});
    setWorkflowBasePath('/v2');
    const handler = vi.fn(async () => Response.json({ ok: true }));

    localQueue.registerHandler('__wkf_workflow_', handler);
    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    expect(handler.mock.calls[0]?.[0].url).toBe(
      'http://localhost/v2/.well-known/workflow/v1/flow'
    );
  });

  it('queue retries immediately when handler returns timeoutSeconds: 0', async () => {
    const { setTimeout: mockSetTimeout } = await import('node:timers/promises');
    vi.mocked(mockSetTimeout).mockClear();

    let callCount = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        if (callCount < 3) {
          return { timeoutSeconds: 0 };
        }
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

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

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          '[local world] Queue operation failed: detected "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer"'
        ),
        expect.objectContaining({
          queueName: '__wkf_workflow_test',
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
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload, {
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
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload, {
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
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload, {
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
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        callCount++;
        return undefined;
      }
    );

    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

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

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

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

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

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

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    await vi.waitFor(() => expect(attempts.length).toBe(1));
    expect(attempts[0]).toBe(1);
  });
});

describe('queue transport timeouts', () => {
  const envKeys = [
    'WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS',
    'WORKFLOW_LOCAL_BODY_TIMEOUT_MS',
  ] as const;

  let server: Server | undefined;

  afterEach(async () => {
    for (const key of envKeys) delete process.env[key];
    if (server !== undefined) {
      const toClose = server;
      server = undefined;
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
    vi.restoreAllMocks();
  });

  it('bounds queue requests by default', () => {
    expect(getQueueAgentOptions()).toMatchObject({
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    });
  });

  it('honors environment overrides, including 0', () => {
    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = '1234';
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '0';
    expect(getQueueAgentOptions()).toMatchObject({
      bodyTimeout: 0,
      headersTimeout: 1234,
    });
  });

  it('falls back for invalid environment overrides', () => {
    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = 'not-a-number';
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '-1';
    expect(getQueueAgentOptions()).toMatchObject({
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    });
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

    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = '0';
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '0';
    const localQueue = createQueue({
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);
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

  it('redelivers when a handler accepts a request but never responds', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests++;
      if (requests === 1) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = '150';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const localQueue = createQueue({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    try {
      await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);
      await vi.waitFor(() => expect(requests).toBe(2), { timeout: 5_000 });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Queue delivery failed at the transport'),
        expect.objectContaining({
          error: expect.stringContaining('fetch failed'),
        })
      );
    } finally {
      await localQueue.close();
    }
  });

  it('redelivers when a handler response body stalls', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      if (requests === 1) {
        response.write('{"ok":');
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '150';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const localQueue = createQueue({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    try {
      await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);
      await vi.waitFor(() => expect(requests).toBe(2), { timeout: 5_000 });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Queue delivery failed at the transport'),
        expect.objectContaining({
          error: expect.stringMatching(/terminated|fetch failed/),
        })
      );
    } finally {
      await localQueue.close();
    }
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
      await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);
      await vi.waitFor(() => expect(attempts.length).toBe(1), {
        timeout: 5_000,
      });
      expect(attempts[0]).toBe('1');
    } finally {
      await localQueue.close();
    }
  });

  // Redelivery on a transport throw is the queue's own logic, not undici's, so
  // it survives the switch. Node's client raises ECONNRESET where undici would
  // have raised a TypeError wrapping UND_ERR_SOCKET; the delivery loop keys on
  // neither, so both retry the same durable message.
  it('still retries a transport throw', async () => {
    let calls = 0;
    server = createServer((request, response) => {
      calls++;
      if (calls < 3) {
        request.socket.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    const localQueue = createQueue({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);
      await vi.waitFor(() => expect(calls).toBe(3), { timeout: 20_000 });
    } finally {
      await localQueue.close();
    }
  }, 30_000);

  // close() owns a socket pool here too, just Node's rather than undici's. It
  // still has to settle, still has to be idempotent, and still has to stop
  // in-flight deliveries via the abort controller it owns.
  it('closes idempotently', async () => {
    const localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    await expect(localQueue.close()).resolves.toBeUndefined();
    await expect(localQueue.close()).resolves.toBeUndefined();
  });
});
