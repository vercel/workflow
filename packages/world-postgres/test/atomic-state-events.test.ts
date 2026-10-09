import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { ulid } from 'ulid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage } from '../src/storage.js';

/**
 * A guarded state update and its event row must commit together (#3081).
 * Each case refuses the event row with a trigger after the update has run,
 * the same window a crash or a failed insert opens, and requires the entity
 * to stay where the event log left it and no terminal announcement to go out.
 */
describe('atomic state events (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let events: ReturnType<typeof createEventsStorage>;
  let listener: Client;
  const announced: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    // One connection, as in storage.test.ts: nothing inside the atomic
    // transaction may need a second pool connection.
    pool = new Pool({ connectionString: dbUrl, max: 1 });
    events = createEventsStorage(createClient(pool));
    listener = new Client({ connectionString: dbUrl });
    await listener.connect();
    listener.on('notification', (message) => {
      if (message.payload) announced.push(message.payload);
    });
    await listener.query('LISTEN workflow_run_status');
    await pool.query(`
      CREATE TABLE workflow.refused_event (type text, correlation_id text);
      CREATE FUNCTION workflow.refuse_event() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM workflow.refused_event r
          WHERE r.type = NEW.type
            AND r.correlation_id IS NOT DISTINCT FROM NEW.correlation_id
        ) THEN
          RAISE EXCEPTION 'event row refused for the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_event BEFORE INSERT ON workflow.workflow_events
        FOR EACH ROW EXECUTE FUNCTION workflow.refuse_event();
    `);
  }, 120_000);

  beforeEach(async () => {
    announced.length = 0;
    await pool.query('DELETE FROM workflow.refused_event');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM workflow.refused_event');
  });

  afterAll(async () => {
    await listener.end();
    await pool.end();
    await container.stop();
  });

  async function runWithRunningStep() {
    const created = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'deployment',
        workflowName: 'workflow',
        input: new Uint8Array([1]),
      },
    });
    const runId = created.run?.runId;
    if (!runId) throw new Error('run not created');
    await events.create(runId, { eventType: 'run_started' });
    const stepId = `step_${ulid()}`;
    await events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'step', input: new Uint8Array([2]) },
    });
    await events.create(runId, {
      eventType: 'step_started',
      correlationId: stepId,
    });
    return { runId, stepId };
  }

  async function refuse(type: string, correlationId: string | null) {
    await pool.query(
      'INSERT INTO workflow.refused_event (type, correlation_id) VALUES ($1, $2)',
      [type, correlationId]
    );
  }

  const row = async (sql: string, id: string) =>
    (await pool.query(sql, [id])).rows[0] as Record<string, unknown>;
  const stepStatus = async (stepId: string) =>
    (
      await row(
        'SELECT status FROM workflow.workflow_steps WHERE step_id = $1',
        stepId
      )
    ).status;
  const runStatus = async (runId: string) =>
    (
      await row(
        'SELECT status FROM workflow.workflow_runs WHERE id = $1',
        runId
      )
    ).status;
  const eventTypes = async (runId: string) =>
    (
      await pool.query(
        'SELECT type FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id',
        [runId]
      )
    ).rows.map((r) => r.type as string);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  test.each([
    ['step_completed', { result: new Uint8Array([3]) }],
    ['step_failed', { error: new Uint8Array([4]) }],
    ['step_retrying', { error: new Uint8Array([5]) }],
  ] as const)('a refused %s event leaves the step running', async (eventType, eventData) => {
    const { runId, stepId } = await runWithRunningStep();
    await refuse(eventType, stepId);
    await expect(
      events.create(runId, {
        eventType,
        correlationId: stepId,
        eventData: { stepName: 'step', workflowName: 'workflow', ...eventData },
      } as never)
    ).rejects.toThrow();
    expect(await stepStatus(stepId)).toBe('running');
    expect(await eventTypes(runId)).not.toContain(eventType);

    // The same write succeeds once the event row is accepted.
    await pool.query('DELETE FROM workflow.refused_event');
    await events.create(runId, {
      eventType,
      correlationId: stepId,
      eventData: { stepName: 'step', workflowName: 'workflow', ...eventData },
    } as never);
    expect(await eventTypes(runId)).toContain(eventType);
  });

  test('a refused wait_completed event leaves the wait waiting', async () => {
    const { runId } = await runWithRunningStep();
    const correlationId = `wait_${ulid()}`;
    await events.create(runId, {
      eventType: 'wait_created',
      correlationId,
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    } as never);
    const waitStatus = async () =>
      (
        await row(
          'SELECT status FROM workflow.workflow_waits WHERE wait_id = $1',
          `${runId}-${correlationId}`
        )
      ).status;
    await refuse('wait_completed', correlationId);
    await expect(
      events.create(runId, { eventType: 'wait_completed', correlationId })
    ).rejects.toThrow();
    expect(await waitStatus()).toBe('waiting');
    expect(await eventTypes(runId)).not.toContain('wait_completed');

    await pool.query('DELETE FROM workflow.refused_event');
    await events.create(runId, { eventType: 'wait_completed', correlationId });
    expect(await waitStatus()).toBe('completed');
    expect(await eventTypes(runId)).toContain('wait_completed');
  });

  test.each([
    ['run_completed', { output: new Uint8Array([6]) }, 'completed'],
    ['run_failed', { error: new Uint8Array([7]) }, 'failed'],
    ['run_cancelled', undefined, 'cancelled'],
  ] as const)('a refused %s event leaves the run running and unannounced', async (eventType, eventData, terminal) => {
    const { runId } = await runWithRunningStep();
    await refuse(eventType, null);
    await expect(
      events.create(runId, { eventType, eventData } as never)
    ).rejects.toThrow();
    await settle();
    expect(await runStatus(runId)).toBe('running');
    expect(announced).not.toContain(runId);

    await pool.query('DELETE FROM workflow.refused_event');
    await events.create(runId, { eventType, eventData } as never);
    expect(await runStatus(runId)).toBe(terminal);
    await settle();
    expect(announced.filter((id) => id === runId)).toEqual([runId]);
  });
});
