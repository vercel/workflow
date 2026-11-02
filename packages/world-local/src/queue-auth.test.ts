import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  getQueueAuthKey,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
} from '@workflow/utils';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from './queue';

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

  it("declares 'in-process-key'", () => {
    localQueue = createQueue({ baseUrl: 'http://localhost:3000' });
    expect(localQueue.queueAuth).toBe('in-process-key');
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

  it('gives the message up after one marked 401, logging one line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    localQueue = createQueue({});
    const handler = vi.fn(async (_req: Request) => refusal());
    localQueue.registerHandler('__wkf_workflow_', handler);

    await localQueue.queue('__wkf_workflow_test' as any, {
      runId: 'wrun_refused',
    });
    await drain();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toContain(
      'refused by the app as unauthenticated; giving up the message (not retried)'
    );
    expect(errors.mock.calls[0]?.[1]).toMatchObject({
      queueName: '__wkf_workflow_test',
      runId: 'wrun_refused',
      refusedSinceLastLog: 1,
      hint: expect.stringContaining('WORKFLOW_QUEUE_AUTH=off'),
    });
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

    // One delivery per message, one log line for all of them.
    expect(handler).toHaveBeenCalledTimes(25);
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
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
