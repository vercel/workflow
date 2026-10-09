import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const run = promisify(execFile);

/**
 * A connection the server drops must not end the process. Each case runs in a
 * subprocess (`fixtures/dropped-connections.mjs`, which imports the built
 * `dist/`), because a missing `'error'` listener surfaces as an uncaught
 * exception: the process exits non-zero instead of printing its result.
 */
describe('Postgres dropped connections (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  // Unique, so the test can tell a leaked password from any other text.
  const password = randomUUID();
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withPassword(password)
      .start();
    execSync('pnpm db:push', {
      stdio: 'ignore',
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_POSTGRES_URL: container.getConnectionUri(),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  async function dropConnections(mode: 'world' | 'checked-out') {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        fileURLToPath(
          new URL('./fixtures/dropped-connections.mjs', import.meta.url)
        ),
        mode,
      ],
      {
        env: {
          ...process.env,
          WORKFLOW_POSTGRES_URL: container.getConnectionUri(),
        },
        timeout: 15_000,
      }
    );
    return { result: JSON.parse(stdout), stderr };
  }

  test("survives losing idle connections in a World's own pool", async () => {
    const { result, stderr } = await dropConnections('world');
    // The pool's read connections, plus the streamer's LISTEN client.
    expect(result.dropped).toBeGreaterThanOrEqual(2);
    expect(result.readAfterDrop).toBe(true);
    expect(stderr).toContain(
      '[world-postgres] Pooled PostgreSQL connection lost (57P01): terminating connection due to administrator command'
    );
    expect(stderr).not.toContain(password);
  });

  test('survives losing a checked-out client between statements', async () => {
    const { result, stderr } = await dropConnections('checked-out');
    expect(result).toEqual({ dropped: 1, heldQueryRejected: true });
    expect(stderr).toContain(
      '[world-postgres] Pooled PostgreSQL connection lost (57P01)'
    );
    expect(stderr).not.toContain(password);
  });
});
