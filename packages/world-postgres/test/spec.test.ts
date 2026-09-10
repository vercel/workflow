import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, expect, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});

  // Sealed-log noop tolerance (specVersion 7): world-postgres allocates
  // positions from its own counter and never seals holes itself, but a
  // `noop` is a legal resident of any spec-7 slot log, and the storage layer
  // must round-trip one — store it at its slot, list it back in order, and
  // keep numbering past it. Direct storage access (not the conformance
  // server): only a backend sealer would ever write one, and the public
  // CreateEventSchema excludes it.
  test('stores, lists, and numbers past a noop event', async () => {
    // Storage layer only — createWorld would also spin up the queue and the
    // streamer's dedicated LISTEN client, which have no shutdown hook here
    // and would die noisily when afterAll stops the container.
    const { createClient } = await import('../dist/drizzle/index.js');
    const { createEventsStorage } = await import('../dist/storage.js');
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: process.env.WORKFLOW_POSTGRES_URL,
      max: 2,
    });
    const world = { events: createEventsStorage(createClient(pool)) };

    const serialized = (value: unknown) =>
      ({ data: JSON.stringify(value), encoding: 'json' }) as any;
    const created = await world.events.create('', {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_noop',
        workflowName: 'noopWorkflow',
        input: serialized([]),
      },
    } as any);
    const runId = created.event!.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    } as any);
    await world.events.create(runId, {
      eventType: 'noop',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { sealed: true },
    } as any);
    await world.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step_after_noop',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'afterNoop', input: serialized([]) },
    } as any);

    const result = await world.events.list({
      runId,
      pagination: { limit: 100 },
    });
    expect(result.data.map((event: any) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'noop',
      'step_created',
    ]);
    expect(
      result.data.map((event: any) => eventIdToSlot(event.eventId))
    ).toEqual([
      FIRST_EVENT_SLOT,
      FIRST_EVENT_SLOT + 1,
      FIRST_EVENT_SLOT + 2,
      FIRST_EVENT_SLOT + 3,
    ]);
    await pool.end();
  }, 60_000);

  createTestSuite('./dist/index.js');
}
