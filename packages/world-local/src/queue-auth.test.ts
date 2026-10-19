import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import {
  QUEUE_AUTH_HEADER,
  QUEUE_SECRET_ENV,
} from '@workflow/world/queue-auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from './queue.js';

// Retry backoffs resolve immediately.
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const SECRET = 's'.repeat(64);
const QUEUE_NAME = '__wkf_workflow_test';

/** Headers a VQS-shaped delivery carries; all valid, none a credential. */
const VQS_HEADERS = {
  'content-type': 'application/json',
  'x-vqs-queue-name': QUEUE_NAME,
  'x-vqs-message-id': 'msg_01FORGED0000000000000000',
  'x-vqs-message-attempt': '1',
};

function forged(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/.well-known/workflow/v1/flow', {
    method: 'POST',
    headers: { ...VQS_HEADERS, ...headers },
    body: JSON.stringify({ runId: 'wrun_01FORGED', requestedAt: new Date() }),
  });
}

const queues: ReturnType<typeof createQueue>[] = [];
const servers: Server[] = [];

function queueWith(config: Parameters<typeof createQueue>[0]) {
  const queue = createQueue(config);
  queues.push(queue);
  return queue;
}

/** Serve a `(req: Request) => Promise<Response>` on a loopback port. */
async function serve(
  handle: (req: Request, raw: IncomingMessage) => Promise<Response>
) {
  const server = createServer(
    async (raw: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of raw) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === 'string') headers.set(k, v);
      }
      const response = await handle(
        new Request(`http://127.0.0.1${raw.url}`, {
          method: raw.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }),
        raw
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
  vi.stubEnv(QUEUE_SECRET_ENV, '');
});

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        })
    )
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('queue handler authentication', () => {
  it.each([
    ['no credential', {}],
    ['a wrong credential', { [QUEUE_AUTH_HEADER]: `Bearer ${'x'.repeat(64)}` }],
  ])('rejects %s before reading the body or calling the handler', async (_, extra) => {
    const handler = vi.fn(async () => undefined);
    const route = queueWith({ queueSecret: SECRET }).createQueueHandler(
      '__wkf_workflow_',
      handler
    );
    const req = forged(extra);

    const res = await route(req);

    expect(res.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads the secret from WORKFLOW_QUEUE_SECRET when no option is given', async () => {
    vi.stubEnv(QUEUE_SECRET_ENV, SECRET);
    const handler = vi.fn(async () => undefined);
    const route = queueWith({}).createQueueHandler('__wkf_workflow_', handler);

    expect((await route(forged())).status).toBe(401);
    const ok = await route(forged({ [QUEUE_AUTH_HEADER]: `Bearer ${SECRET}` }));
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails closed without a secret outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => undefined);
    const route = queueWith({}).createQueueHandler('__wkf_workflow_', handler);
    const req = forged();

    const res = await route(req);

    expect(res.status).toBe(503);
    expect(req.bodyUsed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts unauthenticated deliveries without a secret in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const handler = vi.fn(async () => undefined);
    const route = queueWith({}).createQueueHandler('__wkf_workflow_', handler);

    expect((await route(forged())).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('queue sender authentication', () => {
  it('authenticates HTTP deliveries to a receiver sharing the secret', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const received = Promise.withResolvers<unknown>();
    const receiver = queueWith({ queueSecret: SECRET }).createQueueHandler(
      '__wkf_workflow_',
      async (message) => {
        received.resolve(message);
      }
    );
    const baseUrl = await serve(receiver);
    const sender = queueWith({ baseUrl, queueSecret: SECRET });

    await sender.queue(
      QUEUE_NAME,
      { runId: 'wrun_01LEGIT' },
      // A caller-supplied credential never reaches the wire.
      { headers: { [QUEUE_AUTH_HEADER]: 'Bearer forged' } }
    );

    await expect(received.promise).resolves.toEqual({ runId: 'wrun_01LEGIT' });
  });

  it('never delivers when the sender and receiver secrets differ', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => undefined);
    const statuses: number[] = [];
    const receiver = queueWith({ queueSecret: SECRET }).createQueueHandler(
      '__wkf_workflow_',
      handler
    );
    const baseUrl = await serve(async (req) => {
      const res = await receiver(req);
      statuses.push(res.status);
      return res;
    });
    const sender = queueWith({ baseUrl, queueSecret: 'o'.repeat(64) });

    await sender.queue(QUEUE_NAME, { runId: 'wrun_01MISMATCH' });

    await vi.waitFor(() => expect(statuses.length).toBeGreaterThan(2));
    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(handler).not.toHaveBeenCalled();
  });

  it('authenticates in-process deliveries through a registered handler', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const received = Promise.withResolvers<unknown>();
    const queue = queueWith({ queueSecret: SECRET });
    queue.registerHandler(
      '__wkf_workflow_',
      queue.createQueueHandler('__wkf_workflow_', async (message) => {
        received.resolve(message);
      })
    );

    await queue.queue(QUEUE_NAME, { runId: 'wrun_01DIRECT' });

    await expect(received.promise).resolves.toEqual({
      runId: 'wrun_01DIRECT',
    });
  });

  it('does not follow a redirect with the credential attached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const elsewhere: (string | undefined)[] = [];
    const target = await serve(async (_req, raw) => {
      elsewhere.push(raw.headers[QUEUE_AUTH_HEADER] as string | undefined);
      return Response.json({ ok: true });
    });
    let redirects = 0;
    const baseUrl = await serve(async () => {
      redirects++;
      return new Response(null, {
        status: 307,
        headers: { location: `${target}/steal` },
      });
    });
    const sender = queueWith({ baseUrl, queueSecret: SECRET });

    await sender.queue(QUEUE_NAME, { runId: 'wrun_01REDIRECT' });

    await vi.waitFor(() => expect(redirects).toBeGreaterThan(2));
    expect(elsewhere).toEqual([]);
  });
});
