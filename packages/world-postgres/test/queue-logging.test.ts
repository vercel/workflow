import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const run = promisify(execFile);

/**
 * What Graphile Worker writes to stderr when a delivery fails, captured from a
 * real worker in a subprocess (`fixtures/failing-queue.mjs`, which imports the
 * built `dist/queue.js`). The serializer itself is unit-tested in
 * `src/queue-logging.test.ts`; this pins down that Graphile hands the logger
 * the `Error` in `meta` and that the two output controls still hold.
 */
describe('Postgres queue error logs (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  async function failDelivery(jsonMode: boolean) {
    return await run(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/failing-queue.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          DEBUG: '',
          WORKFLOW_JSON_MODE: jsonMode ? '1' : '0',
          WORKFLOW_POSTGRES_URL: container.getConnectionUri(),
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
});
