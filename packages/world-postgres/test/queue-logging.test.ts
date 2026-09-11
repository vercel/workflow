import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const run = promisify(execFile);

describe.skipIf(process.platform === 'win32')(
  'Postgres queue error logs',
  () => {
    const database = `queue_logging_${randomUUID().replaceAll('-', '')}`;
    let container:
      | Awaited<ReturnType<PostgreSqlContainer['start']>>
      | undefined;
    let admin: Pool;
    let connectionString: string;

    beforeAll(async () => {
      let sourceUrl = process.env.WORKFLOW_POSTGRES_URL;
      if (sourceUrl === undefined) {
        container = await new PostgreSqlContainer('postgres:15-alpine').start();
        sourceUrl = container.getConnectionUri();
      }
      const url = new URL(sourceUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error(
          'Queue logging tests require a loopback PostgreSQL server'
        );
      }
      admin = new Pool({ connectionString: url.href, max: 1 });
      await admin.query(`CREATE DATABASE "${database}"`);
      url.pathname = `/${database}`;
      connectionString = url.href;
    }, 120_000);

    afterAll(async () => {
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
      if (container) await container.stop();
    });

    async function failDelivery(jsonMode: boolean) {
      return await run(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/failing-queue.mjs', import.meta.url)
          ),
        ],
        {
          env: {
            ...process.env,
            DEBUG: '',
            WORKFLOW_JSON_MODE: jsonMode ? '1' : '0',
            WORKFLOW_POSTGRES_URL: connectionString,
          },
          timeout: 15_000,
        }
      );
    }

    test('preserves the delivery error and stack in worker metadata', async () => {
      const { stdout, stderr } = await failDelivery(false);
      expect(stdout).toBe('');
      expect(stderr).toContain('[Graphile Worker] Failed task');
      const metadataStart = stderr.indexOf('{\n');
      expect(metadataStart).toBeGreaterThan(-1);
      const metadata = JSON.parse(stderr.slice(metadataStart));
      expect(metadata.error).toMatchObject({
        name: 'Error',
        message:
          '[postgres world] Queue execution failed (503): test queue delivery failure',
        stack: expect.stringContaining(
          'Error: [postgres world] Queue execution failed (503): test queue delivery failure'
        ),
      });
    });

    test('keeps worker output suppressed in CLI JSON mode', async () => {
      const { stdout, stderr } = await failDelivery(true);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    });
  }
);
