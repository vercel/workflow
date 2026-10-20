import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setWorkflowBasePath } from '@workflow/utils';
import type { WorkflowInvokePayload } from '@workflow/world';
import {
  MessageId,
  NODE_HTTP_ENV_VAR,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  ValidQueueName,
} from '@workflow/world';
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

  it('createQueueHandler reports a delivery-count header as deliveryCount, separate from attempt', async () => {
    const metas: { attempt: number; deliveryCount?: number }[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (_message, meta) => {
        metas.push({
          attempt: meta.attempt,
          deliveryCount: meta.deliveryCount,
        });
        return undefined;
      }
    );
    const request = (extra: Record<string, string>) =>
      new Request('http://localhost/flow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': '__wkf_workflow_test',
          'x-vqs-message-id': 'msg_01ABC',
          'x-vqs-message-attempt': '1',
          ...extra,
        },
        body: JSON.stringify(workflowPayload),
      });
    await handler(request({ 'x-vqs-message-delivery-count': '3' }));
    await handler(request({}));
    expect(metas).toEqual([
      { attempt: 1, deliveryCount: 3 },
      { attempt: 1, deliveryCount: 1 },
    ]);
  });

  it('treats invocation return values containing timeoutSeconds as data', async () => {
    const result = { timeoutSeconds: 123, value: 'data' };
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => result
    );
    const response = await handler(
      new Request('http://localhost/flow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': '__wkf_workflow_test',
          'x-vqs-message-id': 'msg_input',
          'x-vqs-message-attempt': '1',
        },
        body: JSON.stringify({
          ...workflowPayload,
          invoke: true,
          requestId: 'input',
          input: {},
        }),
      })
    );
    expect(await response.json()).toEqual({ result });
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

  it('redelivers the SAME message on timeoutSeconds: one id, one createdAt, increasing deliveryCount', async () => {
    const metas: {
      messageId: string;
      deliveryCount?: number;
      attempt: number;
      createdAt?: Date;
    }[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (_body, meta) => {
        metas.push(meta);
        return metas.length < 3 ? { timeoutSeconds: 1 } : undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    const { messageId } = await localQueue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload,
      { idempotencyKey: 'step_01ABC', retentionSeconds: 3600 }
    );

    await vi.waitFor(() => {
      expect(metas).toHaveLength(3);
    });
    expect(metas.map((meta) => meta.messageId)).toEqual([
      messageId,
      messageId,
      messageId,
    ]);
    expect(metas.map((meta) => meta.deliveryCount)).toEqual([1, 2, 3]);
    expect(metas.map((meta) => meta.attempt)).toEqual([1, 2, 3]);
    expect(metas[0]?.createdAt).toBeInstanceOf(Date);
    expect(new Set(metas.map((meta) => meta.createdAt?.getTime())).size).toBe(
      1
    );
  });

  it('dedupes a second send under the same idempotency key while the first message is retrying', async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        calls++;
        if (calls === 1) {
          await held;
          return { timeoutSeconds: 1 };
        }
        return undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    const first = await localQueue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload,
      { idempotencyKey: 'step_01ABC' }
    );
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    const second = await localQueue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload,
      { idempotencyKey: 'step_01ABC' }
    );
    expect(second.messageId).toBe(first.messageId);
    release();
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
  });

  it('delivers a wake sent without an idempotency key every time', async () => {
    let calls = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        calls++;
        return undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);
    const wake = { runId: 'run_01ABC' };
    const a = await localQueue.queue('__wkf_workflow_test' as any, wake);
    const b = await localQueue.queue('__wkf_workflow_test' as any, wake);
    expect(a.messageId).not.toBe(b.messageId);
    await vi.waitFor(() => {
      expect(calls).toBe(2);
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

  it('places no deadline on queue requests by default', () => {
    const defaults = getQueueAgentOptions();
    expect(defaults).toMatchObject({
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    });

    // `0` is the documented value that disables a deadline.
    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = '0';
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '0';
    const unbounded = getQueueAgentOptions();
    expect(defaults.headersTimeout).toBe(unbounded.headersTimeout);
    expect(defaults.bodyTimeout).toBe(unbounded.bodyTimeout);
  });

  it('honors environment overrides', () => {
    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = '1234';
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = '5678';
    expect(getQueueAgentOptions()).toMatchObject({
      bodyTimeout: 5678,
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

  it('redelivers when a handler exceeds an opt-in headers deadline', async () => {
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

  it('redelivers when a handler response body exceeds an opt-in body deadline', async () => {
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

describe('per-run orchestrator serialization', () => {
  let localQueue: ReturnType<typeof createQueue>;
  const spec9 = (runId: string) => ({
    runId,
    runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
  });

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.restoreAllMocks();
  });

  /**
   * Registers a handler that records every delivery and holds each one until
   * the test releases it, tracking how many deliveries of each run's
   * orchestrator overlap.
   */
  function holdingHandler() {
    const started: { runId: string; stepId?: string }[] = [];
    const releases: (() => void)[] = [];
    const active = new Map<string, number>();
    const maxActive = new Map<string, number>();
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (message) => {
        const { runId, stepId } = message as {
          runId: string;
          stepId?: string;
        };
        const key = stepId ? `${runId}/${stepId}` : runId;
        active.set(key, (active.get(key) ?? 0) + 1);
        maxActive.set(
          key,
          Math.max(maxActive.get(key) ?? 0, active.get(key) ?? 0)
        );
        started.push({ runId, stepId });
        await new Promise<void>((resolve) => releases.push(resolve));
        active.set(key, (active.get(key) ?? 1) - 1);
        return undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);
    return { started, releases, maxActive };
  }

  it('holds a second orchestrator delivery of a spec 9 run until the first finishes', async () => {
    const { started, releases, maxActive } = holdingHandler();
    await localQueue.queue('__wkf_workflow_test' as any, spec9('run_a'));
    await localQueue.queue('__wkf_workflow_test' as any, spec9('run_a'));
    await vi.waitFor(() => expect(started).toHaveLength(1));
    // Give the second delivery every chance to start.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);

    releases[0]?.();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    releases[1]?.();
    expect(maxActive.get('run_a')).toBe(1);
  });

  // A spec 8 orchestrator can hold an inline step until another wake of
  // the same run aborts it, so its deliveries must not wait for each other.
  it('never holds back an orchestrator delivery of a spec 8 or unstamped run', async () => {
    const { started, releases } = holdingHandler();
    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'run_a',
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR - 1,
    });
    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'run_a',
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR - 1,
    });
    await localQueue.queue('__wkf_workflow_test' as any, { runId: 'run_b' });
    await localQueue.queue('__wkf_workflow_test' as any, { runId: 'run_b' });
    await vi.waitFor(() => expect(started).toHaveLength(4));
    for (const release of releases) release();
  });

  it('keeps different runs, and a run’s steps, in parallel with its orchestrator', async () => {
    const { started, releases } = holdingHandler();
    await localQueue.queue('__wkf_workflow_test' as any, spec9('run_a'));
    await localQueue.queue('__wkf_workflow_test' as any, spec9('run_b'));
    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'run_a',
      stepId: 'step_1',
      stepName: 'add',
    });
    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'run_a',
      stepId: 'step_2',
      stepName: 'add',
    });
    await localQueue.queue(
      '__wkf_workflow_test' as any,
      {
        __healthCheck: true,
        correlationId: 'hc_1',
        runId: 'run_a',
      } as any
    );
    await vi.waitFor(() => expect(started).toHaveLength(5));
    for (const release of releases) release();
  });

  it('frees the run while a delivery waits out its timeoutSeconds', async () => {
    let firstCalls = 0;
    const order: string[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (message) => {
        const { tag } = message as { tag: string };
        order.push(tag);
        if (tag === 'first' && firstCalls++ === 0) {
          return { timeoutSeconds: 1 };
        }
        return undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);
    // `setTimeout` from node:timers/promises is mocked to resolve at once, so
    // hold the redelivery delay open on a promise this test controls.
    const { setTimeout: mockedSleep } = await import('node:timers/promises');
    let wakeRedelivery!: () => void;
    vi.mocked(mockedSleep).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          wakeRedelivery = () => resolve(undefined);
        }) as any
    );
    await localQueue.queue(
      '__wkf_workflow_test' as any,
      { ...spec9('run_a'), tag: 'first' } as any
    );
    await vi.waitFor(() => expect(order).toEqual(['first']));
    await localQueue.queue(
      '__wkf_workflow_test' as any,
      { ...spec9('run_a'), tag: 'second' } as any
    );
    // The first message is between deliveries, so the second one runs.
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    wakeRedelivery();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second', 'first']));
  });
});

describe('handoff', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.restoreAllMocks();
  });

  /** Delivers one message, answering `{ timeoutSeconds: 0 }` twice. */
  async function deliveriesOf(payload: Record<string, unknown>) {
    const seen: { attempt: number; deliveryCount?: number; id: string }[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (_message, meta) => {
        seen.push({
          attempt: meta.attempt,
          deliveryCount: meta.deliveryCount,
          id: meta.messageId,
        });
        return seen.length < 3 ? { timeoutSeconds: 0 } : undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);
    await localQueue.queue('__wkf_workflow_test' as any, payload as any);
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    return seen;
  }

  it('redelivers a spec 9 message at once without counting the handed-off deliveries as attempts', async () => {
    const seen = await deliveriesOf({
      runId: 'run_a',
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    expect(seen.map((d) => d.attempt)).toEqual([1, 1, 1]);
    expect(seen.map((d) => d.deliveryCount)).toEqual([1, 2, 3]);
    expect(new Set(seen.map((d) => d.id)).size).toBe(1);
  });

  it('counts an earlier run’s immediate redelivery as an attempt', async () => {
    const seen = await deliveriesOf({ runId: 'run_a' });
    expect(seen.map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(seen.map((d) => d.deliveryCount)).toEqual([1, 2, 3]);
  });
});

describe('per-prefix delivery routes', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      const toClose = server;
      server = undefined;
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
    setWorkflowBasePath(undefined);
  });

  /** A server that answers `servedPaths` with 200 and anything else with 404, recording every request. */
  async function startServer(servedPaths: Set<string>) {
    const requests: { path: string; queueName: string }[] = [];
    server = createServer((request, response) => {
      requests.push({
        path: request.url ?? '',
        queueName: request.headers['x-vqs-queue-name'] as string,
      });
      request.resume();
      const served = servedPaths.has(request.url ?? '');
      response.statusCode = served ? 200 : 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(served ? { ok: true } : { error: 'nf' }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { requests, origin: `http://127.0.0.1:${port}` };
  }

  it("sends a prefix with no registered route to the Workflow SDK's flow route", async () => {
    const { requests, origin } = await startServer(
      new Set(['/.well-known/workflow/v1/flow'])
    );
    const localQueue = createQueue({ baseUrl: origin });
    try {
      await localQueue.queue(
        '__agent_wkf_workflow_session' as ValidQueueName,
        workflowPayload
      );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toEqual({
        path: '/.well-known/workflow/v1/flow',
        queueName: '__agent_wkf_workflow_session',
      });
    } finally {
      await localQueue.close();
    }
  });

  it('delivers a prefix with a registered route there, and only that prefix', async () => {
    const { requests, origin } = await startServer(
      new Set(['/.well-known/workflow/v1/flow', '/api/agent/queue'])
    );
    const localQueue = createQueue({ baseUrl: origin });
    localQueue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    try {
      await localQueue.queue(
        '__agent_wkf_workflow_session' as ValidQueueName,
        workflowPayload
      );
      await localQueue.queue(
        '__wkf_workflow_myWorkflow' as ValidQueueName,
        workflowPayload
      );
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests).toEqual(
        expect.arrayContaining([
          {
            path: '/api/agent/queue',
            queueName: '__agent_wkf_workflow_session',
          },
          {
            path: '/.well-known/workflow/v1/flow',
            queueName: '__wkf_workflow_myWorkflow',
          },
        ])
      );
    } finally {
      await localQueue.close();
    }
  });

  it('resolves a route under the base URL, like the flow route', async () => {
    const { requests, origin } = await startServer(
      new Set(['/base/api/agent/queue'])
    );
    const localQueue = createQueue({ baseUrl: `${origin}/base` });
    localQueue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    try {
      await localQueue.queue(
        '__agent_wkf_workflow_session' as ValidQueueName,
        workflowPayload
      );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]?.path).toBe('/base/api/agent/queue');
    } finally {
      await localQueue.close();
    }
  });

  it('prefers an in-process handler over a route for the same prefix', async () => {
    const { requests, origin } = await startServer(
      new Set(['/api/agent/queue'])
    );
    const localQueue = createQueue({ baseUrl: origin });
    const handler = vi.fn(async (req: Request) => {
      expect(new URL(req.url).pathname).toBe('/api/agent/queue');
      return Response.json({ ok: true });
    });
    localQueue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    localQueue.registerHandler('__agent_wkf_workflow_', handler);
    try {
      await localQueue.queue(
        '__agent_wkf_workflow_session' as ValidQueueName,
        workflowPayload
      );
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(requests).toHaveLength(0);
    } finally {
      await localQueue.close();
    }
  });

  it('a route registered after a message was enqueued takes its next attempt', async () => {
    const { requests, origin } = await startServer(
      new Set(['/api/agent/queue'])
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const localQueue = createQueue({ baseUrl: origin });
    try {
      await localQueue.queue(
        '__agent_wkf_workflow_session' as ValidQueueName,
        workflowPayload
      );
      // The first attempt goes to the flow route, which this app doesn't have.
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(requests[0]?.path).toBe('/.well-known/workflow/v1/flow');
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('HTTP 404'),
        expect.objectContaining({
          hint: expect.stringContaining('world.registerRoute'),
        })
      );

      localQueue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
      await vi.waitFor(() =>
        expect(requests.at(-1)?.path).toBe('/api/agent/queue')
      );
      const settled = requests.length;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      expect(requests).toHaveLength(settled);
    } finally {
      consoleError.mockRestore();
      await localQueue.close();
    }
  });

  it('rejects an invalid prefix or route', () => {
    const localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    expect(() =>
      localQueue.registerRoute('__agent_wkf_workflow_', 'api/agent/queue')
    ).toThrow(TypeError);
    expect(() =>
      localQueue.registerRoute('agent' as never, '/api/agent/queue')
    ).toThrow();
  });

  it("refuses a message outside the handler's prefix, naming both", async () => {
    const localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    const handler = vi.fn();
    const route = localQueue.createQueueHandler('__wkf_workflow_', handler);
    const response = await route(
      new Request('http://localhost:3000/.well-known/workflow/v1/flow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': '__agent_wkf_workflow_session',
          'x-vqs-message-id': 'msg_01ABC',
          'x-vqs-message-attempt': '1',
        },
        body: JSON.stringify(workflowPayload),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Unhandled queue',
      detail:
        'This route handles queue prefix "__wkf_workflow_", not "__agent_wkf_workflow_session".',
    });
    expect(handler).not.toHaveBeenCalled();
    await localQueue.close();
  });
});
