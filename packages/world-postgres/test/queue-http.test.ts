import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue } from '../src/queue.js';

describe.skipIf(process.platform === 'win32')(
  'Postgres queue HTTP deadlines',
  () => {
    const database = `queue_http_${randomUUID().replaceAll('-', '')}`;
    const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    const originalDispatcher = getGlobalDispatcher();
    const shortDeadline = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
    let container:
      | Awaited<ReturnType<PostgreSqlContainer['start']>>
      | undefined;
    let admin: Pool;
    let pool: Pool;
    let connectionString: string;
    let server: Server;
    let phase: 'headers' | 'body' | 'abort';
    let accepted = Promise.withResolvers<void>();
    let disconnected = Promise.withResolvers<void>();
    let attempts: string[] = [];

    beforeAll(async () => {
      let sourceUrl = process.env.WORKFLOW_POSTGRES_URL;
      if (sourceUrl === undefined) {
        container = await new PostgreSqlContainer('postgres:15-alpine').start();
        sourceUrl = container.getConnectionUri();
      }
      const url = new URL(sourceUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error(
          'Queue HTTP tests require a loopback PostgreSQL server'
        );
      }
      admin = new Pool({ connectionString: url.href, max: 1 });
      await admin.query(`CREATE DATABASE "${database}"`);
      url.pathname = `/${database}`;
      connectionString = url.href;
      pool = new Pool({ connectionString, max: 4 });
      server = createServer(async (request, response) => {
        await request.toArray();
        attempts.push(String(request.headers['x-vqs-message-attempt']));
        response.on('close', () => disconnected.resolve());
        accepted.resolve();
        if (phase === 'abort') return;
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.flushHeaders();
        }
        await sleep(1_500);
        response.end('{}');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP server');
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
      setGlobalDispatcher(shortDeadline);
    }, 120_000);

    afterAll(async () => {
      setGlobalDispatcher(originalDispatcher);
      await shortDeadline.close();
      if (originalBaseUrl === undefined)
        delete process.env.WORKFLOW_LOCAL_BASE_URL;
      if (originalBaseUrl !== undefined)
        process.env.WORKFLOW_LOCAL_BASE_URL = originalBaseUrl;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await pool.end();
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
      if (container) await container.stop();
    });

    test.each([
      'headers',
      'body',
    ] as const)('a healthy delivery outlives the global fetch %s deadline', async (delayedPhase) => {
      phase = delayedPhase;
      attempts = [];
      accepted = Promise.withResolvers<void>();
      disconnected = Promise.withResolvers<void>();
      const queue = createQueue(
        {
          connectionString,
          queueConcurrency: 1,
          applicationManagedShutdown: true,
        },
        pool
      );
      try {
        const { messageId } = await queue.queue(
          `${getQueueTopicPrefix('workflow')}test`,
          { runId: `run_${randomUUID()}` }
        );
        await accepted.promise;
        await expect
          .poll(
            async () => {
              const jobs = await pool.query(
                'SELECT count(*)::int AS count FROM graphile_worker._private_jobs WHERE key = $1',
                [messageId]
              );
              return jobs.rows[0].count;
            },
            { timeout: 2_500 }
          )
          .toBe(0);
        expect(attempts).toEqual(['1']);
      } finally {
        await queue.close();
        await pool.query('TRUNCATE graphile_worker._private_jobs');
      }
    });

    test('shutdown still aborts a pending delivery and releases its job', async () => {
      phase = 'abort';
      accepted = Promise.withResolvers<void>();
      disconnected = Promise.withResolvers<void>();
      const queue = createQueue(
        {
          connectionString,
          queueConcurrency: 1,
          applicationManagedShutdown: true,
        },
        pool
      );
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: `run_${randomUUID()}`,
      });
      await accepted.promise;
      await queue.close();
      await disconnected.promise;
      const jobs = await pool.query(
        'SELECT attempts, locked_at FROM graphile_worker._private_jobs'
      );
      expect(jobs.rows).toEqual([{ attempts: 1, locked_at: null }]);
    });
  }
);
