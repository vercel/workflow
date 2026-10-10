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

describe('what a handler can rely on (documented per World)', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.restoreAllMocks();
  });

  it('brings the same message back with attempt + 1 after a throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: { messageId: string; attempt: number }[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (_message, { messageId, attempt }) => {
        seen.push({ messageId, attempt });
        if (attempt === 1) throw new Error('not done');
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    const { messageId } = await localQueue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload
    );

    await vi.waitFor(() =>
      expect(seen).toEqual([
        { messageId, attempt: 1 },
        { messageId, attempt: 2 },
      ])
    );
  });

  it('wakes the same message with attempt + 1 on { timeoutSeconds }', async () => {
    const seen: { messageId: string; attempt: number }[] = [];
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async (_message, { messageId, attempt }) => {
        seen.push({ messageId, attempt });
        return attempt === 1 ? { timeoutSeconds: 5 } : undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    const { messageId } = await localQueue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload
    );

    await vi.waitFor(() =>
      expect(seen).toEqual([
        { messageId, attempt: 1 },
        { messageId, attempt: 2 },
      ])
    );
  });
});

describe('a waiting delivery holds no queue slot', () => {
  // WORKFLOW_LOCAL_QUEUE_CONCURRENCY is read when the module loads, so each
  // test loads a fresh copy with one slot.
  async function createOneSlotQueue() {
    vi.stubEnv('WORKFLOW_LOCAL_QUEUE_CONCURRENCY', '1');
    vi.resetModules();
    const { createQueue: createQueueWithOneSlot } = await import('./queue');
    const { setTimeout: sleep } = await import('node:timers/promises');
    let wake!: () => void;
    // The next wait (a wake's delay or a retry's backoff) lasts until wake().
    vi.mocked(sleep).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          wake = () => resolve(undefined);
        })
    );
    const queue = createQueueWithOneSlot({ baseUrl: 'http://localhost:3000' });
    return { queue, sleep, wake: () => wake() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  for (const [name, firstDelivery, waitMs] of [
    ['a { timeoutSeconds } wake', async () => ({ timeoutSeconds: 60 }), 60_000],
    [
      'the backoff after a throw',
      async () => {
        throw new Error('not done');
      },
      5000,
    ],
  ] as const) {
    it(`frees its slot while waiting out ${name}`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { queue: oneSlot, sleep, wake } = await createOneSlotQueue();
      const seen: string[] = [];
      try {
        const handler = oneSlot.createQueueHandler(
          '__wkf_workflow_',
          async (message, meta) => {
            const { runId } = message as { runId: string };
            seen.push(`${runId}#${meta.attempt}`);
            if (runId === 'run_waiting' && meta.attempt === 1) {
              return firstDelivery();
            }
          }
        );
        oneSlot.registerHandler('__wkf_workflow_', handler);

        await oneSlot.queue('__wkf_workflow_test' as any, {
          runId: 'run_waiting',
        });
        await vi.waitFor(() => expect(seen).toEqual(['run_waiting#1']));
        await vi.waitFor(() =>
          expect(sleep).toHaveBeenCalledWith(waitMs, undefined, {
            signal: expect.any(AbortSignal),
          })
        );

        // The only slot is free while the first message waits.
        await oneSlot.queue('__wkf_workflow_test' as any, {
          runId: 'run_other',
        });
        await vi.waitFor(() =>
          expect(seen).toEqual(['run_waiting#1', 'run_other#1'])
        );

        wake();
        await vi.waitFor(() =>
          expect(seen).toEqual([
            'run_waiting#1',
            'run_other#1',
            'run_waiting#2',
          ])
        );
      } finally {
        await oneSlot.close();
      }
    });
  }

  it('does not deliver a woken message that waited for a slot through close()', async () => {
    const { queue: oneSlot, wake } = await createOneSlotQueue();
    const seen: string[] = [];
    let finishOther!: () => void;
    const otherFinished = new Promise<void>((resolve) => {
      finishOther = resolve;
    });
    const handler = oneSlot.createQueueHandler(
      '__wkf_workflow_',
      async (message, meta) => {
        const { runId } = message as { runId: string };
        seen.push(`${runId}#${meta.attempt}`);
        if (runId === 'run_waiting' && meta.attempt === 1) {
          return { timeoutSeconds: 60 };
        }
        if (runId === 'run_other') await otherFinished;
      }
    );
    oneSlot.registerHandler('__wkf_workflow_', handler);

    await oneSlot.queue('__wkf_workflow_test' as any, { runId: 'run_waiting' });
    await vi.waitFor(() => expect(seen).toEqual(['run_waiting#1']));
    // run_other takes the only slot and keeps it.
    await oneSlot.queue('__wkf_workflow_test' as any, { runId: 'run_other' });
    await vi.waitFor(() =>
      expect(seen).toEqual(['run_waiting#1', 'run_other#1'])
    );

    await oneSlot.close();
    // The wake's delay ends (the mocked sleep ignores close()), and the woken
    // message waits for the slot run_other holds.
    wake();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    finishOther();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(seen).toEqual(['run_waiting#1', 'run_other#1']);
  });
});

describe('the local safety limit', () => {
  let localQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await localQueue.close();
    vi.restoreAllMocks();
  });

  it('keeps waking a message past it when each wake has a delay', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    let deliveries = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        deliveries++;
        return deliveries <= 300 ? { timeoutSeconds: 1 } : undefined;
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    // 256 iterations used to drop the message, delayed wakes included.
    await vi.waitFor(() => expect(deliveries).toBe(301), { timeout: 10_000 });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still drops a message that wakes with no delay forever', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    let deliveries = 0;
    const handler = localQueue.createQueueHandler(
      '__wkf_workflow_',
      async () => {
        deliveries++;
        return { timeoutSeconds: 0 };
      }
    );
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, workflowPayload);

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('exhausted safety limit (256 attempts)'),
        expect.anything()
      )
    );
    expect(deliveries).toBe(256);
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
