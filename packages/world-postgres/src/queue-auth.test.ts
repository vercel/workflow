import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  parseQueueName,
  type ValidQueueName,
} from '@workflow/world';
import {
  QUEUE_AUTH_HEADER,
  QUEUE_SECRET_ENV,
} from '@workflow/world/queue-auth.js';
import { makeWorkerUtils, type Runner, run } from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import { createQueue } from './queue.js';

vi.mock('graphile-worker', () => ({
  Logger: class Logger {
    constructor(_: unknown) {}
  },
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(async () => undefined),
}));

const SECRET = 'p'.repeat(64);
const transport = new JsonTransport();
const pool = { query: vi.fn(async () => ({ rows: [] })) } as any;
const workerUtils = {
  addJob: vi.fn(),
  migrate: vi.fn(),
  release: vi.fn(),
};
const queues: ReturnType<typeof createQueue>[] = [];
const servers: Server[] = [];
let cwd: string;
let dataDir: string;

function job(queueName: string, payload: unknown, headers?: object) {
  const { id, prefix } = parseQueueName(queueName as ValidQueueName);
  return MessageData.encode({
    id,
    prefix,
    data: transport.serialize(payload),
    attempt: 1,
    messageId: MessageId.parse('msg_01PGAUTH000000000000000000'),
    headers: headers as Record<string, string> | undefined,
  });
}

async function startQueue(config: { queueSecret?: string } = {}) {
  const queue = createQueue(
    { connectionString: 'postgres://test', ...config },
    pool
  );
  queues.push(queue);
  await queue.start();
  const task = vi.mocked(run).mock.calls.at(-1)?.[0]?.taskList?.workflow_flows;
  return {
    queue,
    task: task as (payload: unknown, helpers: unknown) => Promise<void>,
  };
}

async function serve(handle: (req: Request) => Promise<Response>) {
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
          body: Buffer.concat(chunks),
        })
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/workflow/v1`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv(QUEUE_SECRET_ENV, '');
  vi.stubEnv('NODE_ENV', 'production');
  vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtils as any);
  vi.mocked(run).mockResolvedValue({
    stop: vi.fn(),
    promise: Promise.resolve(),
  } as unknown as Runner);
  // world-postgres builds its receiving handler from world-local, whose data
  // directory defaults to the working directory. Keep it out of the repo.
  cwd = process.cwd();
  dataDir = await mkdtemp(join(tmpdir(), 'wf-pg-queue-auth-'));
  process.chdir(dataDir);
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
  process.chdir(cwd);
  await rm(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('postgres queue delivery authentication', () => {
  it('delivers a Graphile job to its own queue handler when both share the secret', async () => {
    const { queue, task } = await startQueue({ queueSecret: SECRET });
    const received: unknown[] = [];
    const seenCredentials: (string | null)[] = [];
    const receive = queue.createQueueHandler(
      '__wkf_workflow_',
      async (message) => {
        received.push(message);
      }
    );
    vi.stubEnv(
      'WORKFLOW_LOCAL_BASE_URL',
      (
        await serve(async (req) => {
          seenCredentials.push(req.headers.get(QUEUE_AUTH_HEADER));
          return receive(req);
        })
      ).replace(/\/\.well-known.*$/, '')
    );

    await task(
      // A credential smuggled in through the job's stored headers is replaced.
      job(
        '__wkf_workflow_example',
        { runId: 'wrun_01PG' },
        {
          [QUEUE_AUTH_HEADER]: 'Bearer forged',
        }
      ),
      { job: { attempts: 1 } }
    );

    expect(received).toEqual([{ runId: 'wrun_01PG' }]);
    expect(seenCredentials).toEqual([`Bearer ${SECRET}`]);
  });

  it('rejects a forged delivery to the queue handler before running core', async () => {
    const { queue } = await startQueue({ queueSecret: SECRET });
    const handler = vi.fn(async () => undefined);
    const req = new Request('http://127.0.0.1/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': '__wkf_workflow_example',
        'x-vqs-message-id': 'msg_01FORGED0000000000000000',
        'x-vqs-message-attempt': '1',
      },
      body: JSON.stringify({ runId: 'wrun_01FORGED' }),
    });

    const res = await queue.createQueueHandler('__wkf_workflow_', handler)(req);

    expect(res.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails a job (for Graphile to retry) when the worker and app secrets differ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await startQueue({ queueSecret: SECRET });
    const worker = await startQueue({ queueSecret: 'w'.repeat(64) });
    const handler = vi.fn(async () => undefined);
    const receive = app.queue.createQueueHandler('__wkf_workflow_', handler);
    vi.stubEnv(
      'WORKFLOW_LOCAL_BASE_URL',
      (await serve(receive)).replace(/\/\.well-known.*$/, '')
    );

    await expect(
      worker.task(job('__wkf_workflow_example', { runId: 'wrun_01PG' }), {
        job: { attempts: 1 },
      })
    ).rejects.toThrow(/\(401\)/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never stores the secret on the Graphile job', async () => {
    vi.stubEnv(QUEUE_SECRET_ENV, SECRET);
    const { queue } = await startQueue();

    await queue.queue(
      '__wkf_workflow_example',
      { runId: 'wrun_01PG' },
      {
        headers: { traceparent: 'tp' },
      }
    );

    expect(JSON.stringify(workerUtils.addJob.mock.calls)).not.toContain(SECRET);
  });
});
