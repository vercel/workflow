import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getQueueAuthKey, QUEUE_AUTH_HEADER } from '@workflow/utils';
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

  it('attaches the key to every redelivery and logs a hint on a 401', async () => {
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
      hint: expect.stringContaining('WORKFLOW_QUEUE_AUTH=off'),
    });
    // The key itself is never logged.
    expect(JSON.stringify(errors.mock.calls)).not.toContain(getQueueAuthKey());
  });
});
