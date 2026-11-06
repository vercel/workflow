import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  generateQueueAuthKey,
  getQueueAuthKey,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
} from '@workflow/utils';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQueue,
  MAX_LOCAL_SAFETY_LIMIT,
  MAX_QUEUE_AUTH_REFUSALS,
  MAX_UNCOUNTED_KEY_ROTATIONS,
} from './queue';

// Retry backoffs resolve at once.
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const payload = { runId: 'run_01ABC' };

describe('queue auth key on deliveries', () => {
  let localQueue: ReturnType<typeof createQueue> | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await localQueue?.close();
    localQueue = undefined;
    if (server !== undefined) {
      const toClose = server;
      server = undefined;
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** An HTTP server answering `responses` in turn, recording each request's headers. */
  async function listen(responses: number[] = [200]) {
    const seen: IncomingHttpHeaders[] = [];
    server = createServer((request, response) => {
      seen.push(request.headers);
      const status = responses[Math.min(seen.length, responses.length) - 1];
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(status === 200 ? { ok: true } : 'refused'));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { seen, baseUrl: `http://127.0.0.1:${port}` };
  }

  it("declares 'loopback'", () => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    expect(localQueue.queueAuthMode).toBe('loopback');
  });

  it('attaches the key to an in-process delivery', async () => {
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => Response.json({ ok: true }));
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, payload);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0]?.[0].headers.get(QUEUE_AUTH_HEADER)).toBe(
      getQueueAuthKey()
    );
  });

  it.each([
    ['undici', '0'],
    ['node:http', '1'],
  ])('attaches the key to an HTTP delivery over %s', async (_name, flag) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, flag);
    const { seen, baseUrl } = await listen();
    localQueue = createQueue({ baseUrl });

    await localQueue.queue('__wkf_workflow_test' as any, payload);

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]?.[QUEUE_AUTH_HEADER]).toBe(getQueueAuthKey());
  });

  it('replaces a caller-supplied auth header, whatever its case', async () => {
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => Response.json({ ok: true }));
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, payload, {
      headers: { 'X-Workflow-Auth': 'forged', 'x-workflow-auth': 'forged' },
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0]?.[0].headers.get(QUEUE_AUTH_HEADER)).toBe(
      getQueueAuthKey()
    );
  });

  it('retries a bare 401 (no refusal marker), with the key on every attempt', async () => {
    // A 401 from something in front of the app (a proxy, an auth layer) is
    // not the runtime's refusal and keeps the ordinary retry behavior.
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { seen, baseUrl } = await listen([401, 200]);
    localQueue = createQueue({ baseUrl });

    await localQueue.queue('__wkf_workflow_test' as any, payload);

    await vi.waitFor(() => expect(seen.length).toBe(2));
    for (const headers of seen) {
      expect(headers[QUEUE_AUTH_HEADER]).toBe(getQueueAuthKey());
    }
    const failure = errors.mock.calls.find(([message]) =>
      String(message).includes('HTTP 401')
    );
    expect(failure?.[1]).toMatchObject({
      hint: expect.stringContaining('Retrying'),
    });
    expect(
      errors.mock.calls.some(([message]) =>
        String(message).includes('refused by the app as unauthenticated')
      )
    ).toBe(false);
    // The key itself is never logged.
    expect(JSON.stringify(errors.mock.calls)).not.toContain(getQueueAuthKey());
  });
});

describe('queue auth refusal', () => {
  let localQueue: ReturnType<typeof createQueue> | undefined;

  afterEach(async () => {
    await localQueue?.close();
    localQueue = undefined;
    vi.restoreAllMocks();
  });

  /** The runtime's refusal: a 401 with the marker header and code. */
  const refusal = () =>
    Response.json(
      { error: 'Unauthorized queue delivery', code: QUEUE_AUTH_REFUSED_CODE },
      { status: 401, headers: { [QUEUE_AUTH_REFUSED_HEADER]: '1' } }
    );

  /**
   * Lets every pending delivery loop run to its end. The retry sleeps are
   * mocked to resolve at once and the handler is in process, so a loop that
   * retried would reach the safety limit within these turns.
   */
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('stays bounded, and backs off, when the key changes on every refusal', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sleep).mockClear();
    // A key file rewritten before every reload: each refusal looks fixable.
    let key = generateQueueAuthKey();
    const rotating = {
      current: async () => key,
      reload: async () => {
        key = generateQueueAuthKey();
        return key;
      },
      restore: async () => {},
    };
    localQueue = createQueue({}, { queueAuthKey: rotating });
    const handler = vi.fn(async (_req: Request) => refusal());
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'wrun_rotating',
    });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));

    // The first rotations are retried at once and not counted; past the
    // allowance they count, back off and give the message up, far below
    // the safety limit, with no tight spin.
    expect(handler).toHaveBeenCalledTimes(
      MAX_UNCOUNTED_KEY_ROTATIONS + MAX_QUEUE_AUTH_REFUSALS
    );
    expect(MAX_UNCOUNTED_KEY_ROTATIONS + MAX_QUEUE_AUTH_REFUSALS).toBeLessThan(
      MAX_LOCAL_SAFETY_LIMIT
    );
    expect(vi.mocked(sleep)).toHaveBeenCalledTimes(MAX_QUEUE_AUTH_REFUSALS - 1);
    expect(errors.mock.calls[0]?.[0]).toContain('giving up the message');
  });

  it('retries a marked 401 a bounded number of times, then gives up with one line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => refusal());
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'wrun_refused',
    });
    await drain();

    // MAX_QUEUE_AUTH_REFUSALS deliveries, not the 256 of the safety limit.
    expect(handler).toHaveBeenCalledTimes(MAX_QUEUE_AUTH_REFUSALS);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toContain(
      `refused by the app as unauthenticated ${MAX_QUEUE_AUTH_REFUSALS} times; giving up the message`
    );
    expect(errors.mock.calls[0]?.[1]).toMatchObject({
      queueName: '__wkf_workflow_test',
      runId: 'wrun_refused',
      refusedSinceLastLog: 1,
      hint: expect.stringContaining('WORKFLOW_QUEUE_AUTH=off'),
    });
  });

  // Cluster mode: several processes on one port, each with its own key, so a
  // loopback delivery round-robins and can land on a sibling first. Each
  // message here is refused by "siblings" on its first three deliveries and
  // reaches the process whose key matches on the fourth.
  it('delivers through sibling refusals in cluster mode, counting none as an attempt', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    localQueue = createQueue({});
    const deliveries = new Map<string, number>();
    const accepted: { messageId: string; attempt: string | null }[] = [];
    const handler = vi.fn(async (req: Request) => {
      const messageId = req.headers.get('x-vqs-message-id') ?? '';
      const n = (deliveries.get(messageId) ?? 0) + 1;
      deliveries.set(messageId, n);
      if (n < 4) return refusal();
      accepted.push({
        messageId,
        attempt: req.headers.get('x-vqs-message-attempt'),
      });
      return Response.json({ ok: true });
    });
    localQueue.registerHandler('__wkf_workflow_', handler);

    for (let i = 0; i < 40; i++) {
      await localQueue.queue('__wkf_workflow_test' as any, {
        runId: `wrun_${i}`,
      });
    }
    await drain();

    // Every message delivered exactly once, none lost, nothing logged. The
    // refused deliveries reached no handler, so the accepted one is attempt 1.
    expect(accepted).toHaveLength(40);
    expect(new Set(accepted.map((a) => a.messageId)).size).toBe(40);
    expect(accepted.every((a) => a.attempt === '1')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(40 * 4);
    expect(errors).not.toHaveBeenCalled();
  });

  it('rate-limits the line across many refused messages', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => refusal());
    localQueue.registerHandler('__wkf_workflow_', handler);

    for (let i = 0; i < 25; i++) {
      await localQueue.queue('__wkf_workflow_test' as any, {
        runId: `wrun_${i}`,
      });
    }
    await drain();

    // A bounded number of deliveries per message, one log line for all.
    expect(handler).toHaveBeenCalledTimes(25 * MAX_QUEUE_AUTH_REFUSALS);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('frees the idempotency key of a refused message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => refusal());
    localQueue.registerHandler('__wkf_workflow_', handler);

    const first = await localQueue.queue(
      '__wkf_workflow_test' as any,
      { runId: 'wrun_key' },
      { idempotencyKey: 'key' }
    );
    await drain();
    const second = await localQueue.queue(
      '__wkf_workflow_test' as any,
      { runId: 'wrun_key' },
      { idempotencyKey: 'key' }
    );
    await drain();

    // The given-up message no longer holds the key, so a later send is a new
    // message rather than deduped onto one that will never be delivered.
    expect(second.messageId).not.toBe(first.messageId);
    expect(handler).toHaveBeenCalledTimes(2 * MAX_QUEUE_AUTH_REFUSALS);
  });
});
