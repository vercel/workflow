import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type {
  Hook,
  HookCreatedEventRequest,
  Step,
  WorkflowRun,
} from '@workflow/world';
import { eventIdToSlot, SPEC_VERSION_CURRENT } from '@workflow/world';
import { encode } from 'cbor-x';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import * as DrizzleSchema from '../src/drizzle/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

// Helper types for events storage
type EventsStorage = ReturnType<typeof createEventsStorage>;

// Helper functions to create entities through events.create
async function createRun(
  events: EventsStorage,
  data: {
    deploymentId: string;
    workflowName: string;
    input: Uint8Array;
    executionContext?: Record<string, unknown>;
    attributes?: Record<string, string>;
  }
): Promise<WorkflowRun> {
  const result = await events.create(null, {
    eventType: 'run_created',
    eventData: data,
  });
  if (!result.run) {
    throw new Error('Expected run to be created');
  }
  return result.run;
}

async function updateRun(
  events: EventsStorage,
  runId: string,
  eventType: 'run_started' | 'run_completed' | 'run_failed',
  eventData?: Record<string, unknown>
): Promise<WorkflowRun> {
  const result = await events.create(runId, {
    eventType,
    eventData,
  });
  if (!result.run) {
    throw new Error('Expected run to be updated');
  }
  return result.run;
}

async function createStep(
  events: EventsStorage,
  runId: string,
  data: {
    stepId: string;
    stepName: string;
    input: Uint8Array;
  }
): Promise<Step> {
  const result = await events.create(runId, {
    eventType: 'step_created',
    correlationId: data.stepId,
    eventData: { stepName: data.stepName, input: data.input },
  });
  if (!result.step) {
    throw new Error('Expected step to be created');
  }
  return result.step;
}

async function updateStep(
  events: EventsStorage,
  runId: string,
  stepId: string,
  eventType: 'step_started' | 'step_completed' | 'step_failed',
  eventData?: Record<string, unknown>
): Promise<Step> {
  const result = await events.create(runId, {
    eventType,
    correlationId: stepId,
    eventData,
  });
  if (!result.step) {
    throw new Error('Expected step to be updated');
  }
  return result.step;
}

async function createHook(
  events: EventsStorage,
  runId: string,
  data: HookCreatedEventRequest['eventData'] & { hookId: string }
): Promise<Hook> {
  const { hookId, ...eventData } = data;
  const result = await events.create(runId, {
    eventType: 'hook_created',
    correlationId: hookId,
    eventData,
  });
  if (!result.hook) {
    throw new Error('Expected hook to be created');
  }
  return result.hook;
}

describe('Storage (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let drizzle: ReturnType<typeof createClient>;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;

  async function truncateTables() {
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_events, workflow.workflow_event_slots, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs RESTART IDENTITY CASCADE'
    );
  }

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    // Apply schema
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // Initialize database clients and storage
    pool = new Pool({ connectionString: dbUrl, max: 1 });
    drizzle = createClient(pool);
    runs = createRunsStorage(drizzle);
    steps = createStepsStorage(drizzle);
    events = createEventsStorage(drizzle);
    hooks = createHooksStorage(drizzle);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  describe('runs', () => {
    describe('create', () => {
      it('should create a new workflow run', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          executionContext: { userId: 'user-1' },
          input: new Uint8Array([1, 2]),
        };

        const run = await createRun(events, runData);

        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe('deployment-123');
        expect(run.status).toBe('pending');
        expect(run.workflowName).toBe('test-workflow');
        expect(run.executionContext).toEqual({ userId: 'user-1' });
        expect(run.input).toEqual(new Uint8Array([1, 2]));
        expect(run.output).toBeUndefined();
        expect(run.error).toBeUndefined();
        expect(run.startedAt).toBeUndefined();
        expect(run.completedAt).toBeUndefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });

      it('should handle minimal run data', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'minimal-workflow',
          input: new Uint8Array(),
        };

        const run = await createRun(events, runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual(new Uint8Array());
      });

      it('should seed initial attributes from run_created', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'attributed-workflow',
          input: new Uint8Array(),
          attributes: { tenant: 't1', phase: 'created' },
        });

        expect(run.attributes).toEqual({ tenant: 't1', phase: 'created' });
      });

      it('treats SQL-looking initial attribute keys as literal JSON keys', async () => {
        const key = "tenant'); DROP TABLE workflow_runs; --";
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'attributed-workflow',
          input: new Uint8Array(),
          attributes: { [key]: 'literal' },
        });

        expect(run.attributes).toEqual({ [key]: 'literal' });
      });

      it('rejects a duplicate run_created with EntityConflictError', async () => {
        const runId = `wrun_${ulid()}`;
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array([1, 2]),
        };
        await events.create(runId, {
          eventType: 'run_created',
          eventData: runData,
        });

        await expect(
          events.create(runId, {
            eventType: 'run_created',
            eventData: runData,
          })
        ).rejects.toMatchObject({ name: 'EntityConflictError' });
      });

      it('rejects run_created when resilient start already created the run', async () => {
        // start() races events.create(run_created) against world.queue(). When
        // the worker dequeues first, run_started on the not-yet-existent run
        // takes the resilient start path and creates the run itself. The late
        // run_created must lose loudly: start() treats EntityConflictError as
        // benign, while a silent no-op both fails its `run` assertion and
        // appends a duplicate run_created to the log.
        const runId = `wrun_${ulid()}`;
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array([1, 2]),
        };
        await events.create(runId, {
          eventType: 'run_started',
          eventData: runData,
        });

        await expect(
          events.create(runId, {
            eventType: 'run_created',
            eventData: runData,
          })
        ).rejects.toMatchObject({ name: 'EntityConflictError' });

        const result = await events.list({
          runId,
          pagination: { sortOrder: 'asc' },
        });
        expect(
          result.data.filter((e) => e.eventType === 'run_created')
        ).toHaveLength(1);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array([1]),
        });

        const retrieved = await runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe('test-workflow');
        expect(retrieved.input).toEqual(new Uint8Array([1]));
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toMatchObject({
          name: 'WorkflowRunNotFoundError',
        });
      });
    });

    describe('getMany', () => {
      it('returns requested runs in order and keeps missing IDs as null', async () => {
        const first = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'first-workflow',
          input: new Uint8Array([1]),
        });
        const second = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'second-workflow',
          input: new Uint8Array([2]),
        });

        const result = await runs.getMany(
          [second.runId, 'wrun_missing', first.runId, second.runId],
          { resolveData: 'none' }
        );

        expect(result.map((run) => run?.runId ?? null)).toEqual([
          second.runId,
          null,
          first.runId,
          second.runId,
        ]);
        expect(result[0]?.input).toBeUndefined();
        expect(result[2]?.output).toBeUndefined();
      });

      it('uses one query regardless of duplicate requested IDs', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        const query = vi.spyOn(pool, 'query');

        await runs.getMany([run.runId, 'wrun_missing', run.runId]);

        expect(query).toHaveBeenCalledTimes(1);
      });
    });

    describe('update via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });

        const updated = await updateRun(events, created.runId, 'run_started');
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should reject run_started on a non-existent run', async () => {
        await expect(
          events.create('wrun_nonexistent', {
            eventType: 'run_started',
          })
        ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
      });

      it('should update run status to completed via run_completed event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });

        const updated = await updateRun(
          events,
          created.runId,
          'run_completed',
          {
            output: new Uint8Array([42]),
          }
        );
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(new Uint8Array([42]));
      });

      it('should update run status to failed via run_failed event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });

        // The `error` field is opaque SerializedData (Uint8Array) produced by
        // dehydrateRunError. The storage layer persists it verbatim.
        const serializedError = new Uint8Array([1, 2, 3]);
        const updated = await updateRun(events, created.runId, 'run_failed', {
          error: serializedError,
        });

        expect(updated.status).toBe('failed');
        expect(updated.error).toEqual(serializedError);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun(events, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: new Uint8Array(),
        });

        // Small delay to ensure different timestamps in createdAt
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: new Uint8Array(),
        });

        const result = await runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThan(
          result.data[1].createdAt.getTime()
        );
      });

      it('should filter runs by workflowName', async () => {
        await createRun(events, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: new Uint8Array(),
        });
        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: new Uint8Array(),
        });

        const result = await runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should support pagination', async () => {
        // Create multiple runs
        for (let i = 0; i < 5; i++) {
          await createRun(events, {
            deploymentId: `deployment-${i}`,
            workflowName: `workflow-${i}`,
            input: new Uint8Array(),
          });
        }

        const page1 = await runs.list({
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await runs.list({
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].runId).not.toBe(page1.data[0].runId);
      });

      it('filters by a single status', async () => {
        await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w1',
          input: new Uint8Array(),
        });
        const result = await runs.list({ status: 'pending' });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe('pending');
      });

      it('filters by an array of statuses (matches any)', async () => {
        await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w1',
          input: new Uint8Array(),
        });
        const result = await runs.list({ status: ['pending', 'running'] });
        expect(result.data).toHaveLength(1);
        expect(['pending', 'running']).toContain(result.data[0].status);
      });

      it('returns no runs when status is an empty array (matches SQL `IN ()`)', async () => {
        await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w1',
          input: new Uint8Array(),
        });
        const result = await runs.list({ status: [] });
        expect(result.data).toHaveLength(0);
      });

      it('leaves the filter unset when status field is omitted', async () => {
        await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w1',
          input: new Uint8Array(),
        });
        const result = await runs.list({});
        expect(result.data).toHaveLength(1);
      });
    });

    describe('experimentalSetAttributes', () => {
      it('upserts new keys', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });

        const result = await runs.experimentalSetAttributes!(run.runId, [
          { key: 'phase', value: 'init' },
          { key: 'tenant', value: 't1' },
        ]);
        expect(result.attributes).toEqual({ phase: 'init', tenant: 't1' });

        const fresh = await runs.get(run.runId);
        expect(fresh.attributes).toEqual({ phase: 'init', tenant: 't1' });
      });

      it('merges across calls without clobbering prior keys', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });

        await runs.experimentalSetAttributes!(run.runId, [
          { key: 'a', value: '1' },
        ]);
        const result = await runs.experimentalSetAttributes!(run.runId, [
          { key: 'b', value: '2' },
        ]);
        expect(result.attributes).toEqual({ a: '1', b: '2' });
      });

      it('removes keys when value is null', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });
        await runs.experimentalSetAttributes!(run.runId, [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ]);
        const result = await runs.experimentalSetAttributes!(run.runId, [
          { key: 'a', value: null },
        ]);
        expect(result.attributes).toEqual({ b: '2' });
      });
    });

    describe('native attr_set events', () => {
      it('materializes writes and removals on the run', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
          attributes: { stale: 'remove' },
        });
        const result = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'attr_1',
          eventData: {
            changes: [
              { key: 'phase', value: 'ready' },
              { key: 'stale', value: null },
            ],
            writer: { type: 'workflow' },
          },
        });

        expect(result.event?.eventType).toBe('attr_set');
        expect(result.run?.attributes).toEqual({ phase: 'ready' });
        expect((await runs.get(run.runId)).attributes).toEqual({
          phase: 'ready',
        });
      });

      it('requires reserved-key opt-in on native events', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });
        await expect(
          events.create(run.runId, {
            eventType: 'attr_set',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              changes: [{ key: '$system', value: 'nope' }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/reserved prefix/);

        const result = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [{ key: '$system', value: 'ok' }],
            writer: { type: 'workflow' },
            allowReservedAttributes: true,
          },
        });
        expect(result.run?.attributes).toEqual({ $system: 'ok' });
      });

      it('treats SQL-looking attribute keys as literal JSON keys', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });
        const key = "phase'); DROP TABLE workflow_runs; --";

        const written = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [{ key, value: 'literal' }],
            writer: { type: 'workflow' },
          },
        });
        expect(written.run?.attributes).toEqual({ [key]: 'literal' });

        const removed = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [{ key, value: null }],
            writer: { type: 'workflow' },
          },
        });
        expect(removed.run?.attributes).toEqual({});
      });

      it('enforces the per-run cap against existing attributes', async () => {
        const initial: Record<string, string> = {};
        for (let i = 0; i < 63; i++) initial[`a${i}`] = 'v';
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
          attributes: initial,
        });

        // 64th attribute fits exactly at the cap.
        const atCap = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [{ key: 'a63', value: 'v' }],
            writer: { type: 'workflow' },
          },
        });
        expect(Object.keys(atCap.run?.attributes ?? {})).toHaveLength(64);

        // A 65th attribute exceeds the cap with a clear error.
        await expect(
          events.create(run.runId, {
            eventType: 'attr_set',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              changes: [{ key: 'a64', value: 'v' }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/exceed limit 64/);

        // Upserting an existing key at the cap is a zero-net change.
        const upserted = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [{ key: 'a0', value: 'updated' }],
            writer: { type: 'step', stepId: 'step_1', attempt: 1 },
          },
        });
        expect(upserted.run?.attributes?.a0).toBe('updated');

        // Removing a key frees room for a new one in the same batch.
        const swapped = await events.create(run.runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            changes: [
              { key: 'a1', value: null },
              { key: 'replacement', value: 'v' },
            ],
            writer: { type: 'workflow' },
          },
        });
        expect(swapped.run?.attributes?.replacement).toBe('v');
        expect(swapped.run?.attributes).not.toHaveProperty('a1');
        expect(Object.keys(swapped.run?.attributes ?? {})).toHaveLength(64);
      });

      it('rejects oversized attribute values on attr_set', async () => {
        const run = await createRun(events, {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        });
        await expect(
          events.create(run.runId, {
            eventType: 'attr_set',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              changes: [{ key: 'note', value: 'v'.repeat(257) }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/byte length 257 exceeds limit 256/);
      });

      it('rejects invalid initial attributes on run_created', async () => {
        const overCap: Record<string, string> = {};
        for (let i = 0; i <= 64; i++) overCap[`a${i}`] = 'v';
        await expect(
          createRun(events, {
            deploymentId: 'd',
            workflowName: 'w',
            input: new Uint8Array(),
            attributes: overCap,
          })
        ).rejects.toThrow(/exceed limit 64/);

        await expect(
          createRun(events, {
            deploymentId: 'd',
            workflowName: 'w',
            input: new Uint8Array(),
            attributes: { $reserved: 'nope' },
          })
        ).rejects.toThrow(/reserved prefix/);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step-123',
          stepName: 'test-step',
          input: new Uint8Array([1, 2]),
        };

        const step = await createStep(events, testRunId, stepData);

        expect(step).toMatchObject({
          runId: testRunId,
          stepId: 'step-123',
          stepName: 'test-step',
          status: 'pending',
          input: new Uint8Array([1, 2]),
          output: undefined,
          error: undefined,
          attempt: 0, // steps are created with attempt 0
          startedAt: undefined,
          completedAt: undefined,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          specVersion: SPEC_VERSION_CURRENT,
        });
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        const retrieved = await steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(steps.get(testRunId, 'missing-step')).rejects.toThrow(
          'Step not found'
        );
      });
    });

    describe('update via events', () => {
      it('should update step status to running via step_started event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_started',
          {} // step_started no longer needs attempt in eventData - World increments it
        );

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
        expect(updated.attempt).toBe(1); // Incremented by step_started
      });

      it('allocates the step_started slot after the guarded step update', async () => {
        const stepId = 'step-start-lock';
        await createStep(events, testRunId, {
          stepId,
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        const lockPool = new Pool({
          connectionString: container.getConnectionUri(),
          max: 1,
        });
        const client = await lockPool.connect();
        // The suite's own pool is `max: 1`, so the parked step_started holds
        // it for the duration. The overtaking writer needs a connection of
        // its own, which is also the shape being tested: two processes.
        const otherPool = new Pool({
          connectionString: container.getConnectionUri(),
          max: 1,
        });
        const otherEvents = createEventsStorage(createClient(otherPool));

        try {
          await client.query('BEGIN');
          await client.query(
            'SELECT 1 FROM workflow.workflow_steps WHERE run_id = $1 AND step_id = $2 FOR UPDATE',
            [testRunId, stepId]
          );

          const started = events.create(testRunId, {
            eventType: 'step_started',
            correlationId: stepId,
          });

          await new Promise((resolve) => setTimeout(resolve, 50));
          // Written while step_started is still parked on the step row lock.
          // A writer that drew its slot on entry would already hold a lower
          // one than this; drawing after the lock puts it above.
          const overtaking = await otherEvents.create(testRunId, {
            eventType: 'step_created',
            correlationId: 'step-start-lock-overtaker',
            eventData: { stepName: 'test-step', input: new Uint8Array([1]) },
          });
          await client.query('COMMIT');

          const result = await started;
          if (!result.event || !overtaking.event) {
            throw new Error('Expected both events');
          }
          const startedSlot = eventIdToSlot(result.event.eventId);
          const overtakingSlot = eventIdToSlot(overtaking.event.eventId);
          expect(startedSlot).not.toBeNull();
          expect(overtakingSlot).not.toBeNull();
          expect(startedSlot as number).toBeGreaterThan(
            overtakingSlot as number
          );
        } finally {
          client.release();
          await lockPool.end();
          await otherPool.end();
        }
      });

      it('should update step status to completed via step_completed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_completed',
          { result: new Uint8Array([1]) }
        );

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(new Uint8Array([1]));
      });

      it('should update step status to failed via step_failed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        // The `error` field is opaque SerializedData (Uint8Array) produced by
        // dehydrateStepError. The storage layer persists it verbatim.
        const serializedError = new Uint8Array([1, 2, 3]);
        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_failed',
          { error: serializedError }
        );

        expect(updated.status).toBe('failed');
        expect(updated.error).toEqual(serializedError);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('lazy step start', () => {
      it('creates the step on the fly when step_started carries input', async () => {
        const result = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'lazy-step-1',
          eventData: {
            stepName: 'lazy-step',
            input: new Uint8Array([7, 8, 9]),
          },
        });

        // Created + started in one call: running, attempt 1, ownership signal.
        expect(result.step?.stepId).toBe('lazy-step-1');
        expect(result.step?.stepName).toBe('lazy-step');
        expect(result.step?.status).toBe('running');
        expect(result.step?.attempt).toBe(1);
        expect(result.step?.input).toEqual(new Uint8Array([7, 8, 9]));
        expect(result.stepCreated).toBe(true);

        const persisted = await steps.get(testRunId, 'lazy-step-1');
        expect(persisted.status).toBe('running');
        expect(persisted.input).toEqual(new Uint8Array([7, 8, 9]));
      });

      it('writes a synthetic step_created event (input there, not on step_started)', async () => {
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'lazy-step-2',
          eventData: { stepName: 'lazy-step', input: new Uint8Array([1]) },
        });

        const evts = await events.listByCorrelationId({
          correlationId: 'lazy-step-2',
          runId: testRunId,
        });
        const created = evts.data.find((e) => e.eventType === 'step_created');
        const started = evts.data.find((e) => e.eventType === 'step_started');
        expect(created).toBeDefined();
        expect(started).toBeDefined();
        expect(
          (created?.eventData as { input?: unknown } | undefined)?.input
        ).toBeDefined();
        expect(
          (started?.eventData as { input?: unknown } | undefined)?.input
        ).toBeUndefined();
      });

      it('still rejects a bare step_started (no input) on a missing step', async () => {
        await expect(
          events.create(testRunId, {
            eventType: 'step_started',
            correlationId: 'never-created',
            eventData: { stepName: 'legacy-step' },
          })
        ).rejects.toThrow('not found');
      });

      it('rejects a second lazy step_started for an existing step (concurrent loser)', async () => {
        const first = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'lazy-step-3',
          eventData: { stepName: 'lazy-step', input: new Uint8Array([1]) },
        });
        expect(first.step?.attempt).toBe(1);
        expect(first.stepCreated).toBe(true);

        // The step exists → this caller lost the create race → must not start
        // or run the body. EntityConflictError → executeStep `skipped`.
        await expect(
          events.create(testRunId, {
            eventType: 'step_started',
            correlationId: 'lazy-step-3',
            eventData: { stepName: 'lazy-step', input: new Uint8Array([1]) },
          })
        ).rejects.toMatchObject({ name: 'EntityConflictError' });
      });

      it('crash recovery re-starts via a non-lazy step_started on the existing step', async () => {
        // Owner creates + starts lazily (attempt 1). On recovery the step
        // already exists, so it is re-run via a NON-lazy step_started (no
        // input), which re-starts the step (attempt 2) — at-least-once.
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'lazy-step-4',
          eventData: { stepName: 'lazy-step', input: new Uint8Array([1]) },
        });

        const rerun = await updateStep(
          events,
          testRunId,
          'lazy-step-4',
          'step_started',
          {}
        );
        expect(rerun.status).toBe('running');
        expect(rerun.attempt).toBe(2);
      });

      it('rejects a lazy step_started on a terminal run', async () => {
        await updateRun(events, testRunId, 'run_started');
        await updateRun(events, testRunId, 'run_completed', {
          output: new Uint8Array([1]),
        });

        await expect(
          events.create(testRunId, {
            eventType: 'step_started',
            correlationId: 'lazy-on-terminal',
            eventData: { stepName: 'lazy-step', input: new Uint8Array([1]) },
          })
        ).rejects.toThrow('terminal state');
      });

      it('a lazy step_started followed by step_failed marks the step failed', async () => {
        // Regression guard for the unregistered-step path on the lazy inline
        // route: executeStep sends the lazy step_started to materialize the
        // deferred step, then writes step_failed. Failing a never-created step
        // would hit the "step must exist" ordering guard and wedge the run.
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'lazy-step-fail',
          eventData: { stepName: 'ghost-step', input: new Uint8Array([1]) },
        });

        const failed = await updateStep(
          events,
          testRunId,
          'lazy-step-fail',
          'step_failed',
          { error: new Uint8Array([2, 3]) }
        );
        expect(failed.status).toBe('failed');
        expect(failed.attempt).toBe(1);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await createStep(events, testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: new Uint8Array(),
        });
        const step2 = await createStep(events, testRunId, {
          stepId: 'step-2',
          stepName: 'second-step',
          input: new Uint8Array(),
        });

        const result = await steps.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
        // Should be in descending order
        expect(result.data[0].stepId).toBe(step2.stepId);
        expect(result.data[1].stepId).toBe(step1.stepId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create multiple steps
        for (let i = 0; i < 5; i++) {
          await createStep(events, testRunId, {
            stepId: `step-${i}`,
            stepName: `step-name-${i}`,
            input: new Uint8Array(),
          });
        }

        const page1 = await steps.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].stepId).not.toBe(page1.data[0].stepId);
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const result = await events.create(testRunId, eventData);

        expect(result.event.runId).toBe(testRunId);
        expect(result.event.eventId).toMatch(/^evnt_0{10}/);
        expect(result.event.eventType).toBe('step_started');
        expect(result.event.correlationId).toBe('corr_123');
        expect(result.event.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        // Create step before step_failed event
        await createStep(events, testRunId, {
          stepId: 'corr_123_null',
          stepName: 'test-step-null',
          input: new Uint8Array(),
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr_123_null',
        });

        const result = await events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'corr_123_null',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

        expect(result.event.runId).toBe(testRunId);
        expect(result.event.eventId).toMatch(/^evnt_0{10}/);
        expect(result.event.eventType).toBe('step_failed');
        expect(result.event.correlationId).toBe('corr_123_null');
        expect(result.event.createdAt).toBeInstanceOf(Date);
      });

      it('should handle run completed events', async () => {
        const eventData = {
          eventType: 'run_completed' as const,
          eventData: { output: new Uint8Array([1]) },
        };

        const result = await events.create(testRunId, eventData);

        expect(result.event.eventType).toBe('run_completed');
        expect(result.event.correlationId).toBeUndefined();
      });

      it('skips the run_started preload when requested', async () => {
        const result = await events.create(
          testRunId,
          { eventType: 'run_started' },
          { skipPreload: true }
        );

        expect(result.events).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const result1 = await events.create(testRunId, {
          eventType: 'run_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' }, // Explicitly request ascending order
        });

        // 4 events: run_created (from createRun), run_started, step_created, step_started
        expect(result.data).toHaveLength(4);
        // Should be in chronological order (oldest first)
        expect(result.data[0].eventType).toBe('run_created');
        expect(result.data[1].eventId).toBe(result1.event.eventId);
        expect(result.data[3].eventId).toBe(result2.event.eventId);
        expect(result.data[3].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should list events in descending order when explicitly requested (newest first)', async () => {
        const result1 = await events.create(testRunId, {
          eventType: 'run_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        // 4 events: run_created (from createRun), run_started, step_created, step_started
        expect(result.data).toHaveLength(4);
        // Should be in reverse chronological order (newest first)
        expect(result.data[0].eventId).toBe(result2.event.eventId);
        expect(result.data[1].eventType).toBe('step_created');
        expect(result.data[2].eventId).toBe(result1.event.eventId);
        expect(result.data[3].eventType).toBe('run_created');
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[2].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create multiple events - must create steps first
        for (let i = 0; i < 5; i++) {
          await createStep(events, testRunId, {
            stepId: `corr_${i}`,
            stepName: `test-step-${i}`,
            input: new Uint8Array(),
          });
          // Start the step before completing
          await events.create(testRunId, {
            eventType: 'step_started',
            correlationId: `corr_${i}`,
          });
          await events.create(testRunId, {
            eventType: 'step_completed',
            correlationId: `corr_${i}`,
            eventData: { result: new Uint8Array([i]) },
          });
        }

        const page1 = await events.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await events.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].eventId).not.toBe(page1.data[0].eventId);
      });

      it('returns all remaining events when no limit is set', async () => {
        await events.create(testRunId, {
          eventType: 'run_started',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(2);
        expect(result.hasMore).toBe(false);
      });

      it('returns all events across internal query pages', async () => {
        await drizzle.insert(DrizzleSchema.events).values(
          Array.from({ length: 500 }, () => ({
            eventId: `wevt_${ulid()}`,
            eventType: 'run_started' as const,
            runId: testRunId,
          }))
        );

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(501);
        expect(result.hasMore).toBe(false);
      });

      it('returns a continuation at the configured event ceiling', async () => {
        await events.create(testRunId, {
          eventType: 'run_started',
        });
        vi.stubEnv('WORKFLOW_MAX_EVENTS', '1');

        const first = await events.list({
          runId: testRunId,
        });
        expect(first.data).toHaveLength(1);
        expect(first.hasMore).toBe(true);

        const second = await events.list({
          runId: testRunId,
          pagination: { cursor: first.cursor ?? undefined },
        });
        expect(second.data).toHaveLength(1);
        expect(second.hasMore).toBe(false);
      });
    });

    describe('listByCorrelationId', () => {
      it('should list all events with a specific correlation ID', async () => {
        const correlationId = 'step-abc123';

        // Create step before step events
        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        // Create events with the target correlation ID
        const result1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: new Uint8Array([1]) },
        });

        // Create events with different correlation IDs (should be filtered out)
        await createStep(events, testRunId, {
          stepId: 'different-step',
          stepName: 'different-step',
          input: new Uint8Array(),
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'different-step',
        });
        await events.create(testRunId, {
          eventType: 'run_completed',
          eventData: { output: new Uint8Array([1]) },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: {},
        });

        // 3 events: step_created, step_started, step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventType).toBe('step_created');
        expect(result.data[1].eventId).toBe(result1.event.eventId);
        expect(result.data[1].correlationId).toBe(correlationId);
        expect(result.data[2].eventId).toBe(result2.event.eventId);
        expect(result.data[2].correlationId).toBe(correlationId);
      });

      it('returns only the named run when two runs share a correlation ID', async () => {
        // A correlation id names a hook, step or wait within its run. Two runs
        // can hold the same one — a slot-numbered run counts its own steps, so
        // `step_…001` is the first step of every such run — and the query
        // answers for the run it was given, not for both.
        const correlationId = 'hook-xyz789';

        // Create another run
        const run2 = await createRun(events, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: new Uint8Array(),
        });

        // Create events in both runs with same correlation ID
        const result1 = await events.create(testRunId, {
          eventType: 'hook_created',
          correlationId,
          eventData: { token: 'test-token-1' },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result2 = await events.create(run2.runId, {
          eventType: 'hook_received',
          correlationId,
          eventData: { payload: new Uint8Array([1, 2, 3]) },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result3 = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const result = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: {},
        });

        expect(result.data.map((event) => event.eventId)).toEqual([
          result1.event.eventId,
          result3.event.eventId,
        ]);
        expect(result.data.every((event) => event.runId === testRunId)).toBe(
          true
        );

        // The other run's event is not lost, it belongs to the other run.
        const other = await events.listByCorrelationId({
          correlationId,
          runId: run2.runId,
          pagination: {},
        });
        expect(other.data.map((event) => event.eventId)).toEqual([
          result2.event.eventId,
        ]);
      });

      it('pages a scoped query past a sibling run holding the same correlation ID', async () => {
        // The cursor is an event id, and the scope is what keeps it a key: the
        // sibling run's rows sort into the same id range, so an unscoped page
        // would spend the caller's page budget on a run it did not ask for.
        const correlationId = 'hook_shared_paging';
        const run2 = await createRun(events, {
          deploymentId: 'deployment-789',
          workflowName: 'test-workflow-3',
          input: new Uint8Array(),
        });

        const created = await events.create(testRunId, {
          eventType: 'hook_created',
          correlationId,
          eventData: { token: 'test-token-paging' },
        });
        await events.create(run2.runId, {
          eventType: 'hook_created',
          correlationId,
          eventData: { token: 'test-token-paging-2' },
        });
        const disposed = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await events.listByCorrelationId({
            correlationId,
            runId: testRunId,
            pagination: { limit: 1, cursor },
          });
          expect(page.data.every((event) => event.runId === testRunId)).toBe(
            true
          );
          seen.push(...page.data.map((event) => event.eventId));
          cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
        } while (cursor);

        expect(seen).toEqual([created.event.eventId, disposed.event.eventId]);
      });

      it('should return empty list for non-existent correlation ID', async () => {
        // Create a step and start it
        await createStep(events, testRunId, {
          stepId: 'existing-step',
          stepName: 'existing-step',
          input: new Uint8Array(),
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'existing-step',
        });

        const result = await events.listByCorrelationId({
          correlationId: 'non-existent-correlation-id',
          runId: testRunId,
          pagination: {},
        });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.cursor).toBeNull();
      });

      it('should respect pagination parameters', async () => {
        const correlationId = 'step_paginated';

        // Create step first
        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        // Create multiple events
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId,
          eventData: { error: 'retry error' },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        // Start again after retry
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: new Uint8Array([1]) },
        });

        // Get first page (step_created, step_started, step_retrying)
        const page1 = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: { limit: 3 },
        });

        expect(page1.data).toHaveLength(3);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        // Get second page (step_started, step_completed)
        const page2 = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: { limit: 3, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.hasMore).toBe(false);
      });

      it('should always return full event data', async () => {
        // Create step first
        await createStep(events, testRunId, {
          stepId: 'step-with-data',
          stepName: 'step-with-data',
          input: new Uint8Array(),
        });
        // Start the step before completing
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-with-data',
        });
        await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-with-data',
          eventData: { result: new Uint8Array([1]) },
        });

        // Note: resolveData parameter is ignored by the PG World storage implementation
        const result = await events.listByCorrelationId({
          correlationId: 'step-with-data',
          runId: testRunId,
          pagination: {},
        });

        // 3 events: step_created, step_started, step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[2].correlationId).toBe('step-with-data');
      });

      it('should return events in ascending order by default', async () => {
        const correlationId = 'step-ordering';

        // Create step first
        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        // Create events with slight delays to ensure different timestamps
        const result1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: new Uint8Array([1]) },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: {},
        });

        // 3 events: step_created, step_started, step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[1].eventId).toBe(result1.event.eventId);
        expect(result.data[2].eventId).toBe(result2.event.eventId);
        expect(result.data[1].createdAt.getTime()).toBeLessThanOrEqual(
          result.data[2].createdAt.getTime()
        );
      });

      it('should support descending order', async () => {
        const correlationId = 'step-desc-order';

        // Create step first
        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: new Uint8Array(),
        });

        const result1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: new Uint8Array([1]) },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        // 3 events in descending order: step_completed, step_started, step_created
        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventId).toBe(result2.event.eventId);
        expect(result.data[1].eventId).toBe(result1.event.eventId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should handle hook lifecycle events', async () => {
        const hookId = 'hook_test123';

        // Create a typical hook lifecycle
        const createdResult = await events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: hookId,
          eventData: { token: 'lifecycle-test-token' },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received1Result = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: new Uint8Array([1]) },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received2Result = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: new Uint8Array([2]) },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const disposedResult = await events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: hookId,
        });

        const result = await events.listByCorrelationId({
          correlationId: hookId,
          runId: testRunId,
          pagination: {},
        });

        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventId).toBe(createdResult.event.eventId);
        expect(result.data[0].eventType).toBe('hook_created');
        expect(result.data[1].eventId).toBe(received1Result.event.eventId);
        expect(result.data[1].eventType).toBe('hook_received');
        expect(result.data[2].eventId).toBe(received2Result.event.eventId);
        expect(result.data[2].eventType).toBe('hook_received');
        expect(result.data[3].eventId).toBe(disposedResult.event.eventId);
        expect(result.data[3].eventType).toBe('hook_disposed');
      });

      it('should enforce token uniqueness across different runs', async () => {
        const token = 'unique-token-test';

        // Create first hook with the token
        await events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: 'hook_1',
          eventData: { token },
        });

        // Create another run
        const run2 = await createRun(events, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: new Uint8Array(),
        });

        // Try to create another hook with the same token - should return hook_conflict event
        const result = await events.create(run2.runId, {
          eventType: 'hook_created' as const,
          correlationId: 'hook_2',
          eventData: { token },
        });

        // Should return a hook_conflict event instead of throwing
        expect(result.event.eventType).toBe('hook_conflict');
        expect(result.event.correlationId).toBe('hook_2');
        expect((result.event as any).eventData.token).toBe(token);
        expect((result.event as any).eventData.conflictingRunId).toBe(
          testRunId
        );
        // No hook entity should be created
        expect(result.hook).toBeUndefined();
      });

      it('should allow token reuse after hook is disposed', async () => {
        const token = 'reusable-token-test';

        // Create first hook with the token
        await events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: 'hook_reuse_1',
          eventData: { token },
        });

        // Dispose the first hook
        await events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: 'hook_reuse_1',
        });

        // Create another run
        const run2 = await createRun(events, {
          deploymentId: 'deployment-789',
          workflowName: 'test-workflow-3',
          input: new Uint8Array(),
        });

        // Now creating a hook with the same token should succeed
        const result = await events.create(run2.runId, {
          eventType: 'hook_created' as const,
          correlationId: 'hook_reuse_2',
          eventData: { token },
        });

        expect(result.hook).toBeDefined();
        expect(result.hook!.token).toBe(token);
      });
    });
  });

  describe('slot event ids', () => {
    let testRunId: string;
    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    it('numbers a run densely from the first slot', async () => {
      await updateRun(events, testRunId, 'run_started');

      const result = await events.list({
        runId: testRunId,
        pagination: { sortOrder: 'asc' },
      });

      expect(result.data.map((e) => eventIdToSlot(e.eventId))).toEqual([1, 2]);
    });

    it('gives concurrent writers distinct, dense slots', async () => {
      const writers = 8;
      // The suite's own pool is `max: 1`, which would serialize these writes
      // and defeat the point. Give each writer a connection so they actually
      // contend for the same slot.
      const racePool = new Pool({
        connectionString: container.getConnectionUri(),
        max: writers,
      });
      const raceEvents = createEventsStorage(createClient(racePool));

      try {
        await Promise.all(
          Array.from({ length: writers }, (_, i) =>
            raceEvents.create(testRunId, {
              eventType: 'step_created',
              correlationId: `slot-step-${i}`,
              eventData: {
                stepName: 'test-step',
                input: new Uint8Array([i]),
              },
            })
          )
        );
      } finally {
        await racePool.end();
      }

      const result = await events.list({
        runId: testRunId,
        pagination: { sortOrder: 'asc' },
      });
      const slots = result.data
        .map((e) => eventIdToSlot(e.eventId))
        .sort((a, b) => (a ?? 0) - (b ?? 0));

      // run_created holds slot 1 and the racing writers take the rest: no
      // duplicate (the composite primary key rejects the loser, which retries)
      // and no hole (nothing reserves a slot it does not then use), whatever
      // order they happen to land in.
      expect(slots).toEqual(
        Array.from({ length: writers + 1 }, (_, i) => i + 1)
      );
    });

    it('leaves no hole behind writes that are rejected', async () => {
      const writers = 8;
      const racePool = new Pool({
        connectionString: container.getConnectionUri(),
        max: writers,
      });
      const raceEvents = createEventsStorage(createClient(racePool));

      // Every writer claims the same correlation id, so exactly one
      // step_created survives the entity-creation unique index and the rest
      // are rejected with EntityConflictError. A slot handed out before the
      // insert lands would be burned by each of those rejections, and a burned
      // slot is a permanent hole: allocation only moves forward.
      try {
        const results = await Promise.allSettled(
          Array.from({ length: writers }, () =>
            raceEvents.create(testRunId, {
              eventType: 'step_created',
              correlationId: 'slot-contended-step',
              eventData: {
                stepName: 'test-step',
                input: new Uint8Array([1]),
              },
            })
          )
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      } finally {
        await racePool.end();
      }

      // The next write is what exposes a burned slot: it lands right behind
      // the winner if no rejection consumed a position, and `writers - 1`
      // past it if every rejection did.
      await events.create(testRunId, {
        eventType: 'step_created',
        correlationId: 'slot-after-contention',
        eventData: { stepName: 'test-step', input: new Uint8Array([1]) },
      });

      const result = await events.list({
        runId: testRunId,
        pagination: { sortOrder: 'asc' },
      });
      const slots = result.data
        .map((e) => eventIdToSlot(e.eventId))
        .sort((a, b) => (a ?? 0) - (b ?? 0));

      // run_created, the one step_created that won, and the write after it.
      expect(slots).toEqual([1, 2, 3]);
    });

    it('hands back the events occupying the slots a write skipped', async () => {
      await updateRun(events, testRunId, 'run_started');
      // What a writer that loaded the log right after run_started would report.
      const stale = 2;

      for (let i = 0; i < 3; i++) {
        await events.create(testRunId, {
          eventType: 'step_created',
          correlationId: `skipped-step-${i}`,
          eventData: { stepName: 'test-step', input: new Uint8Array([i]) },
        });
      }

      const result = await events.create(
        testRunId,
        {
          eventType: 'wait_created',
          correlationId: 'skipped-wait',
          eventData: { resumeAt: new Date('2099-01-01') },
        },
        { eventCount: stale }
      );

      expect(eventIdToSlot(result.event.eventId)).toBe(6);
      expect(result.events?.map((e) => eventIdToSlot(e.eventId))).toEqual([
        3, 4, 5,
      ]);
      expect(result.events?.map((e) => e.correlationId)).toEqual([
        'skipped-step-0',
        'skipped-step-1',
        'skipped-step-2',
      ]);
      expect(result.hasMore).toBe(false);
    });

    it('reports nothing when the write lands on the slot it asked for', async () => {
      const result = await events.create(
        testRunId,
        {
          eventType: 'step_created',
          correlationId: 'unskipped-step',
          eventData: { stepName: 'test-step', input: new Uint8Array() },
        },
        { eventCount: 1 }
      );

      expect(eventIdToSlot(result.event.eventId)).toBe(2);
      expect(result.events).toBeUndefined();
    });

    it('reports nothing when the writer sends no count', async () => {
      await updateRun(events, testRunId, 'run_started');
      await events.create(testRunId, {
        eventType: 'step_created',
        correlationId: 'uncounted-step',
        eventData: { stepName: 'test-step', input: new Uint8Array() },
      });

      const result = await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'uncounted-wait',
        eventData: { resumeAt: new Date('2099-01-01') },
      });

      expect(result.events).toBeUndefined();
    });

    it('gives every racing writer the events it was decided without', async () => {
      await updateRun(events, testRunId, 'run_started');
      const stale = 2;
      const writers = 8;
      const racePool = new Pool({
        connectionString: container.getConnectionUri(),
        max: writers,
      });
      const raceEvents = createEventsStorage(createClient(racePool));

      let results: Awaited<ReturnType<typeof raceEvents.create>>[];
      try {
        results = await Promise.all(
          Array.from({ length: writers }, (_, i) =>
            raceEvents.create(
              testRunId,
              {
                eventType: 'step_created',
                correlationId: `race-report-${i}`,
                eventData: {
                  stepName: 'test-step',
                  input: new Uint8Array([i]),
                },
              },
              { eventCount: stale }
            )
          )
        );
      } finally {
        await racePool.end();
      }

      // Each writer's report covers only the slots between the one it asked
      // for and the one it landed on. It can be short of that span: a writer
      // holding a lower slot may not have committed its insert yet, which is
      // what `hasMore` says.
      for (const result of results) {
        const landed = eventIdToSlot(result.event.eventId) as number;
        const reported = result.events ?? [];
        const span = landed - stale - 1;
        expect(reported.length).toBeLessThanOrEqual(span);
        expect(result.hasMore ?? false).toBe(reported.length < span);
        for (const event of reported) {
          const slot = eventIdToSlot(event.eventId) as number;
          expect(slot).toBeGreaterThan(stale);
          expect(slot).toBeLessThan(landed);
        }
      }
    });
  });

  describe('concurrent entity-creation races', () => {
    let testRunId: string;
    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
      await updateRun(events, testRunId, 'run_started');
    });

    it('should reject concurrent step_created with the same correlationId', async () => {
      // Two concurrent step_created calls with identical correlationIds
      // (as produced by the snapshot runtime's deterministic ULIDs across
      // concurrent VM invocations of the same resumption) must produce
      // exactly one step_created event in the log. The unique partial
      // index on workflow_events ensures the loser's INSERT raises a
      // unique-violation, which storage translates to EntityConflictError
      // for the runtime's existing dedup catch path.
      const results = await Promise.allSettled([
        createStep(events, testRunId, {
          stepId: 'step_dup_1',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        }),
        createStep(events, testRunId, {
          stepId: 'step_dup_1',
          stepName: 'test-step',
          input: new Uint8Array([2]),
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });

      // Verify only one step_created event exists in the log.
      const evts = await events.list({
        runId: testRunId,
        pagination: {},
      });
      const stepCreated = evts.data.filter(
        (e) =>
          e.eventType === 'step_created' && e.correlationId === 'step_dup_1'
      );
      expect(stepCreated).toHaveLength(1);
    });

    it('should reject sequential duplicate step_created with EntityConflictError', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_seq_dup',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await expect(
        createStep(events, testRunId, {
          stepId: 'step_seq_dup',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toMatchObject({
        name: 'EntityConflictError',
        message: `step_created for correlationId "step_seq_dup" already exists in run "${testRunId}"`,
      });
    });

    it('recovers an orphaned step row before a plain step_started event', async () => {
      const stepId = 'step_orphan';
      await drizzle.insert(DrizzleSchema.steps).values({
        runId: testRunId,
        stepId,
        stepName: 'test-step',
        input: new Uint8Array(),
        status: 'pending',
        attempt: 0,
        specVersion: SPEC_VERSION_CURRENT,
      });

      const recovered = await createStep(events, testRunId, {
        stepId,
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      expect(recovered.stepId).toBe(stepId);

      await updateStep(events, testRunId, stepId, 'step_started');

      const evts = await events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        evts.data
          .filter((event) => event.correlationId === stepId)
          .map((event) => event.eventType)
      ).toEqual(['step_created', 'step_started']);
    });

    it('rolls back the step entity when the matching event insert fails', async () => {
      await pool.query(`
        CREATE FUNCTION workflow.reject_step_created_event_for_test()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.type = 'step_created'
            AND NEW.correlation_id = 'step_partial_write'
          THEN
            RAISE EXCEPTION 'forced step_created event insert failure';
          END IF;
          RETURN NEW;
        END;
        $$;

        CREATE TRIGGER reject_step_created_event_for_test
        BEFORE INSERT ON workflow.workflow_events
        FOR EACH ROW
        EXECUTE FUNCTION workflow.reject_step_created_event_for_test();
      `);

      try {
        await expect(
          createStep(events, testRunId, {
            stepId: 'step_partial_write',
            stepName: 'test-step',
            input: new Uint8Array(),
          })
        ).rejects.toMatchObject({
          cause: {
            message: expect.stringMatching(
              /forced step_created event insert failure/
            ),
          },
        });

        const stepRows = await drizzle
          .select({ stepId: DrizzleSchema.steps.stepId })
          .from(DrizzleSchema.steps)
          .where(eq(DrizzleSchema.steps.stepId, 'step_partial_write'));
        expect(stepRows).toEqual([]);

        const evts = await events.list({
          runId: testRunId,
          pagination: {},
        });
        expect(
          evts.data.filter(
            (event) =>
              event.eventType === 'step_created' &&
              event.correlationId === 'step_partial_write'
          )
        ).toHaveLength(0);
      } finally {
        await pool.query(`
          DROP TRIGGER reject_step_created_event_for_test
            ON workflow.workflow_events;
          DROP FUNCTION workflow.reject_step_created_event_for_test();
        `);
      }
    });

    it('should reject duplicate correlated workflow attr_set events', async () => {
      await events.create(testRunId, {
        eventType: 'attr_set',
        correlationId: 'attr_dup_1',
        eventData: {
          changes: [{ key: 'phase', value: 'running' }],
          writer: { type: 'workflow' },
        },
      });
      await expect(
        events.create(testRunId, {
          eventType: 'attr_set',
          correlationId: 'attr_dup_1',
          eventData: {
            changes: [{ key: 'phase', value: 'running' }],
            writer: { type: 'workflow' },
          },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // A duplicate carrying *different* changes for the same correlationId
      // must be rejected before touching the run snapshot — otherwise the
      // materialized attributes would diverge from the event log.
      await expect(
        events.create(testRunId, {
          eventType: 'attr_set',
          correlationId: 'attr_dup_1',
          eventData: {
            changes: [{ key: 'phase', value: 'DIVERGED' }],
            writer: { type: 'workflow' },
          },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
      expect((await runs.get(testRunId)).attributes?.phase).toBe('running');

      const evts = await events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        evts.data.filter(
          (event) =>
            event.eventType === 'attr_set' &&
            event.correlationId === 'attr_dup_1'
        )
      ).toHaveLength(1);
    });

    it('should reject duplicate wait_created with EntityConflictError', async () => {
      // Sequential duplicate wait_created — the wait_created insert path
      // uses `INSERT ... onConflictDoNothing()` plus an existence check, so
      // the second insert is silently dropped at the SQL level. The unique
      // partial index on workflow_events still provides a stronger
      // concurrent guarantee here, and the storage layer translates the
      // resulting unique-violation into an EntityConflictError matching the
      // step_created behavior.
      await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait_seq_dup',
        eventData: { resumeAt: new Date('2099-01-01') },
      });
      await expect(
        events.create(testRunId, {
          eventType: 'wait_created',
          correlationId: 'wait_seq_dup',
          eventData: { resumeAt: new Date('2099-01-02') },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // Mirror the step_created test: assert exactly one wait_created
      // event landed in the log, so a regression that allowed both
      // inserts through would fail this test even if the second
      // insert's translation to EntityConflictError still worked.
      const evts = await events.list({
        runId: testRunId,
        pagination: {},
      });
      const waitCreated = evts.data.filter(
        (e) =>
          e.eventType === 'wait_created' && e.correlationId === 'wait_seq_dup'
      );
      expect(waitCreated).toHaveLength(1);
    });

    it('should reject duplicate same-hook hook_created with EntityConflictError, not hook_conflict', async () => {
      // Regression test for https://github.com/vercel/workflow/issues/2283
      //
      // Duplicate processing of the *same* (runId, hookId, token) — e.g.
      // queue redelivery or cross-process replay — must be idempotent.
      // It must throw EntityConflictError (mirroring the step_created
      // duplicate path) so the runtime's existing concurrent-replay catch
      // path swallows it, and must NOT append a hook_conflict event that
      // would later replay as a self-conflict HookConflictError.
      const token = 'idempotent-token';
      const hookId = 'hook_idem_1';

      await createHook(events, testRunId, { hookId, token });

      // Same runId, same hookId, same token — must be idempotent.
      await expect(
        events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // No hook_conflict event should have been written to the log.
      const evts = await events.list({
        runId: testRunId,
        pagination: {},
      });
      const hookCreatedEvents = evts.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      const hookConflictEvents = evts.data.filter(
        (e) => e.eventType === 'hook_conflict'
      );
      expect(hookCreatedEvents).toHaveLength(1);
      expect(hookConflictEvents).toHaveLength(0);
    });

    it('should still emit hook_conflict for a different hookId reusing the same token in the same run', async () => {
      // The idempotency guard must NOT mask genuine token conflicts — a
      // different hookId reusing the same token (even in the same run)
      // is still a real conflict.
      const token = 'same-run-different-hook-token';

      await createHook(events, testRunId, { hookId: 'hook_a', token });

      const result = await events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook_b',
        eventData: { token },
      });

      expect(result.event.eventType).toBe('hook_conflict');
      expect((result.event as any).eventData.conflictingRunId).toBe(testRunId);
      expect(result.hook).toBeUndefined();
    });

    it('should still emit hook_conflict for the same hookId in a different run reusing the same token', async () => {
      // The idempotency guard checks (runId, hookId) together — a
      // different run reusing the same hookId (highly unlikely in
      // practice, but a worthwhile boundary) must still produce a real
      // hook_conflict.
      const token = 'cross-run-same-hookid-token';
      const hookId = 'hook_shared_id';

      await createHook(events, testRunId, { hookId, token });

      const otherRun = await createRun(events, {
        deploymentId: 'deployment-other',
        workflowName: 'other-workflow',
        input: new Uint8Array(),
      });

      const result = await events.create(otherRun.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });

      expect(result.event.eventType).toBe('hook_conflict');
      expect((result.event as any).eventData.conflictingRunId).toBe(testRunId);
      expect(result.hook).toBeUndefined();
    });

    it('should recover an orphaned hook row that lacks a hook_created event', async () => {
      // Crash-recovery regression: in `events.create`, the hook INSERT
      // (line ~1185 of storage.ts) and the events INSERT (line ~1314)
      // are not wrapped in a single transaction. If a process / DB
      // interruption lands between them, the hook row exists but no
      // `hook_created` event is in the log. The same-`(runId, hookId)`
      // retry must not be treated as a "real duplicate" — that would
      // throw EntityConflictError, which the runtime's concurrent-
      // replay catch path would swallow, permanently leaving the run
      // with a hook entity but no `hook_created` event in the log.
      //
      // The recovery path detects the missing event and completes the
      // partial write: it skips re-inserting the hook row and lets the
      // outer code path emit the `hook_created` event.
      const token = 'orphaned-hook-row-token';
      const hookId = 'hook_orphan_pg_1';

      // Pre-seed an orphaned hook row that has no corresponding
      // `hook_created` event in the events table.
      await drizzle.insert(DrizzleSchema.hooks).values({
        runId: testRunId,
        hookId,
        token,
        ownerId: '',
        projectId: '',
        environment: '',
        specVersion: SPEC_VERSION_CURRENT,
        isWebhook: false,
        isSystem: false,
      });

      // Sanity: the hook row exists but no hook_created event is in
      // the log yet.
      const preEvents = await events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        preEvents.data.filter((e) => e.eventType === 'hook_created').length
      ).toBe(0);

      // Retry: must succeed and emit a hook_created event, NOT a
      // hook_conflict event, and NOT throw EntityConflictError.
      const result = await events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });

      expect(result.event.eventType).toBe('hook_created');
      expect(result.hook?.hookId).toBe(hookId);

      const postEvents = await events.list({
        runId: testRunId,
        pagination: {},
      });
      const created = postEvents.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      const conflicts = postEvents.data.filter(
        (e) => e.eventType === 'hook_conflict'
      );
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(0);
    });

    it('does not mutate an already-committed hook entity when a duplicate hook_created retry collides', async () => {
      // Parallel to the world-local regression for karthikscale3's
      // review on PR #2295. world-postgres uses
      // `.insert(Schema.hooks).onConflictDoNothing()` so a duplicate
      // hook_created retry'\''s hook INSERT is a no-op against an
      // already-committed row — but this test guards against a
      // future regression that adds an UPDATE/UPSERT or otherwise
      // mutates the existing entity in the dedup path.
      const token = 'no-mutate-on-duplicate-token-pg';
      const hookId = 'hook_no_mutate_on_duplicate_pg';
      const originalMetadata = encode({ v: 'a' }) as Uint8Array;
      const retryMetadata = encode({ v: 'b' }) as Uint8Array;

      // First write: original metadata + isWebhook: true.
      const first = await events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: {
          token,
          metadata: originalMetadata,
          isWebhook: true,
        },
      });
      expect(first.event.eventType).toBe('hook_created');
      expect(first.hook?.isWebhook).toBe(true);

      // Retry with DIFFERENT metadata and isWebhook.
      await expect(
        events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: {
            token,
            metadata: retryMetadata,
            isWebhook: false,
          },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // The hook entity still has the ORIGINAL metadata and
      // isWebhook — the retry'\''s payload did NOT overwrite the
      // already-committed entity.
      const persisted = await hooks.get(hookId);
      expect(persisted.isWebhook).toBe(true);
      // Compare metadata as bytes since cbor round-trips through
      // Buffer / Uint8Array.
      expect(Buffer.from(persisted.metadata as Uint8Array)).toEqual(
        Buffer.from(originalMetadata)
      );

      // Exactly one hook_created event in the log.
      const evts = await events.list({
        runId: testRunId,
        pagination: { limit: 100 },
      });
      const hookCreated = evts.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      expect(hookCreated).toHaveLength(1);
    });

    it('converges same-hook creation across concurrent calls to one event', async () => {
      // Cross-worker convergence regression. The events table's
      // partial unique index
      // (workflow_events_entity_creation_unique on
      // runId+correlationId+eventType for hook_created/step_created/
      // wait_created) makes the events INSERT the durable
      // convergence point — at most one `hook_created` event with
      // the same `(runId, correlationId)` can land. The dedup branch
      // can race with the original INSERT (both probe getHookByToken
      // before the loser sees the event), but the outer events
      // INSERT then raises 23505 (unique-violation) which is
      // translated to EntityConflictError that the runtime's
      // existing concurrent-replay catch path swallows. Net result:
      // exactly one `hook_created` event per logical creation.
      //
      // This test is the world-postgres counterpart to the
      // `converges same-hook creation across workers to one event`
      // test in world-local, exercising true in-process concurrency
      // since world-postgres has no per-process tag isolation.
      const attempts = 25;
      for (let i = 0; i < attempts; i++) {
        const correlationId = `hook_pg_converge_${i}`;
        const token = `token-pg-converge-${i}`;
        await Promise.allSettled([
          events.create(testRunId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
          events.create(testRunId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
        ]);
      }

      const evts = await events.list({
        runId: testRunId,
        pagination: { limit: 1000 },
      });
      const created = evts.data.filter((e) => e.eventType === 'hook_created');
      const conflicts = evts.data.filter(
        (e) => e.eventType === 'hook_conflict'
      );
      expect(created).toHaveLength(attempts);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe('step terminal state validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('completed step', () => {
      it('should reject step_started on completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_terminal_1',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_1',
          'step_completed',
          {
            result: new Uint8Array([1]),
          }
        );

        await expect(
          updateStep(events, testRunId, 'step_terminal_1', 'step_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_completed on already completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_terminal_2',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_2',
          'step_completed',
          {
            result: new Uint8Array([1]),
          }
        );

        await expect(
          updateStep(events, testRunId, 'step_terminal_2', 'step_completed', {
            result: new Uint8Array([2]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_terminal_3',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_3',
          'step_completed',
          {
            result: new Uint8Array([1]),
          }
        );

        await expect(
          updateStep(events, testRunId, 'step_terminal_3', 'step_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('failed step', () => {
      it('should reject step_started on failed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_failed_1',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(events, testRunId, 'step_failed_1', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(events, testRunId, 'step_failed_1', 'step_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_completed on failed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_failed_2',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(events, testRunId, 'step_failed_2', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(events, testRunId, 'step_failed_2', 'step_completed', {
            result: new Uint8Array([3]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on already failed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_failed_3',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(events, testRunId, 'step_failed_3', 'step_failed', {
          error: 'Failed once',
        });

        await expect(
          updateStep(events, testRunId, 'step_failed_3', 'step_failed', {
            error: 'Failed again',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_retrying on failed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_failed_retry',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          events,
          testRunId,
          'step_failed_retry',
          'step_failed',
          {
            error: 'Failed permanently',
          }
        );

        await expect(
          updateStep(events, testRunId, 'step_failed_retry', 'step_retrying', {
            error: 'Retry attempt',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('step_retrying validation', () => {
      it('should reject step_retrying on completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_completed_retry',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          events,
          testRunId,
          'step_completed_retry',
          'step_completed',
          {
            result: new Uint8Array([1]),
          }
        );

        await expect(
          updateStep(
            events,
            testRunId,
            'step_completed_retry',
            'step_retrying',
            {
              error: 'Retry attempt',
            }
          )
        ).rejects.toThrow(/terminal/i);
      });
    });
  });

  describe('run terminal state validation', () => {
    describe('completed run', () => {
      it('should reject run_started on completed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_completed', {
          output: new Uint8Array([1]),
        });

        await expect(
          updateRun(events, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on completed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_completed', {
          output: new Uint8Array([1]),
        });

        await expect(
          updateRun(events, run.runId, 'run_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on completed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_completed', {
          output: new Uint8Array([1]),
        });

        await expect(
          events.create(run.runId, { eventType: 'run_cancelled' })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('failed run', () => {
      it('should reject run_started on failed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(events, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_completed on failed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(events, run.runId, 'run_completed', {
            output: new Uint8Array([2]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on failed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          events.create(run.runId, { eventType: 'run_cancelled' })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('cancelled run', () => {
      it('should reject run_started on cancelled run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(events, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_completed on cancelled run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(events, run.runId, 'run_completed', {
            output: new Uint8Array([2]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on cancelled run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(events, run.runId, 'run_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });
  });

  describe('allowed operations on terminal runs', () => {
    it('should allow step_completed on completed run for in-progress step', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create and start a step (making it in-progress)
      await createStep(events, run.runId, {
        stepId: 'step_in_progress',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(events, run.runId, 'step_in_progress', 'step_started');

      // Complete the run while step is still running
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      // Should succeed - completing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        events,
        run.runId,
        'step_in_progress',
        'step_completed',
        { result: new Uint8Array([1]) }
      );
      expect(result.status).toBe('completed');
    });

    it('should allow step_failed on completed run for in-progress step', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create and start a step
      await createStep(events, run.runId, {
        stepId: 'step_in_progress_fail',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(
        events,
        run.runId,
        'step_in_progress_fail',
        'step_started'
      );

      // Complete the run
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      // Should succeed - failing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        events,
        run.runId,
        'step_in_progress_fail',
        'step_failed',
        { error: 'step failed' }
      );
      expect(result.status).toBe('failed');
    });

    it('should auto-delete hooks when run completes (postgres-specific behavior)', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create a hook
      await createHook(events, run.runId, {
        hookId: 'hook_auto_deleted',
        token: 'test-token-dispose',
      });

      // Complete the run - this auto-deletes the hook
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      // The hook should no longer exist because run completion auto-deletes hooks
      // This is intentional behavior to allow token reuse across runs
      await expect(
        events.create(run.runId, {
          eventType: 'hook_disposed',
          correlationId: 'hook_auto_deleted',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should retain a hook until its deadline after the run completes', async () => {
      const token = 'retained-token';
      const tokenRetentionUntil = new Date(Date.now() + 60_000);
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      const hook = await createHook(events, run.runId, {
        hookId: 'hook_retained',
        token,
        tokenRetentionUntil,
      });
      expect(hook.tokenRetentionUntil).toEqual(tokenRetentionUntil);

      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array(),
      });

      expect((await hooks.get(hook.hookId)).runId).toBe(run.runId);
      expect(await hooks.getByToken(token)).toMatchObject({
        runId: run.runId,
        tokenRetentionUntil,
      });
      expect((await hooks.list({ runId: run.runId })).data).toHaveLength(1);
      await expect(
        events.create(run.runId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: {} },
        })
      ).rejects.toMatchObject({ name: 'RunExpiredError' });

      const duplicateRun = await createRun(events, {
        deploymentId: 'deployment-456',
        workflowName: 'duplicate-workflow',
        input: new Uint8Array(),
      });
      const conflict = await events.create(duplicateRun.runId, {
        eventType: 'hook_created',
        correlationId: 'hook_duplicate',
        eventData: { token },
      });
      expect(conflict.event.eventType).toBe('hook_conflict');

      await events.create(run.runId, {
        eventType: 'hook_disposed',
        correlationId: hook.hookId,
      });
      expect(
        (
          await createHook(events, duplicateRun.runId, {
            hookId: 'hook_replacement',
            token,
          })
        ).runId
      ).toBe(duplicateRun.runId);
    });

    it('rejects retention beyond the 30-day default before writing Hook state', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      const hookId = 'hook_over_retention_limit';

      await expect(
        createHook(events, run.runId, {
          hookId,
          token: 'over-retention-limit',
          tokenRetentionUntil: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        })
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        status: 400,
        message:
          'Hook minimum retention cannot exceed 30 days in the Postgres World.',
      });

      await expect(
        drizzle
          .select()
          .from(DrizzleSchema.hooks)
          .where(eq(DrizzleSchema.hooks.hookId, hookId))
      ).resolves.toEqual([]);
      await expect(
        drizzle
          .select()
          .from(DrizzleSchema.events)
          .where(eq(DrizzleSchema.events.correlationId, hookId))
      ).resolves.toEqual([]);
    });

    it('accepts retention within the configured Postgres limit', async () => {
      vi.stubEnv('WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS', '60');
      const configuredEvents = createEventsStorage(drizzle);
      const run = await createRun(configuredEvents, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      await expect(
        createHook(configuredEvents, run.runId, {
          hookId: 'hook_custom_retention_limit',
          token: 'custom-retention-limit',
          tokenRetentionUntil: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        })
      ).resolves.toMatchObject({ hookId: 'hook_custom_retention_limit' });
    });

    it('should release a retained hook after its deadline', async () => {
      const token = 'elapsed-retention-token';
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      const hook = await createHook(events, run.runId, {
        hookId: 'hook_elapsed_retention',
        token,
        tokenRetentionUntil: new Date(Date.now() + 60_000),
      });

      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array(),
      });
      await drizzle
        .update(DrizzleSchema.hooks)
        .set({ tokenRetentionUntil: new Date(Date.now() - 1) })
        .where(eq(DrizzleSchema.hooks.hookId, hook.hookId));
      await expect(hooks.get(hook.hookId)).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
      await expect(hooks.getByToken(token)).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });

      const replacementRun = await createRun(events, {
        deploymentId: 'deployment-456',
        workflowName: 'replacement-workflow',
        input: new Uint8Array(),
      });
      await createHook(events, replacementRun.runId, {
        hookId: 'hook_after_retention',
        token,
      });

      const rows = await drizzle
        .select({ hookId: DrizzleSchema.hooks.hookId })
        .from(DrizzleSchema.hooks)
        .where(eq(DrizzleSchema.hooks.token, token));
      expect(rows).toEqual([{ hookId: 'hook_after_retention' }]);
    });
  });

  describe('disallowed operations on terminal runs', () => {
    it('should reject step_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started on completed run for pending step', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create a step but don't start it
      await createStep(events, run.runId, {
        stepId: 'pending_step',
        stepName: 'test-step',
        input: new Uint8Array(),
      });

      // Complete the run
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      // Should reject - cannot start a pending step on a terminal run
      await expect(
        updateStep(events, run.runId, 'pending_step', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook',
          token: 'new-token',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject attr_set on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      await expect(
        events.create(run.runId, {
          eventType: 'attr_set',
          correlationId: 'attr_after_complete',
          eventData: {
            changes: [{ key: 'phase', value: 'too-late' }],
            writer: { type: 'workflow' },
          },
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on failed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_failed',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on cancelled run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_cancelled',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on failed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook_failed',
          token: 'new-token-failed',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on cancelled run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook_cancelled',
          token: 'new-token-cancelled',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_received on a completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      const hook = await createHook(events, run.runId, {
        hookId: 'hook_before_complete',
        token: 'token-before-complete',
      });
      await updateRun(events, run.runId, 'run_completed', {
        output: new Uint8Array([1]),
      });

      // run_completed's hook/wait cleanup runs before hook_received is
      // attempted here, so this sequential case surfaces as the hook no
      // longer existing rather than the terminal-run guard below (which
      // covers the case where hook_received's write is still in flight
      // when the run terminates concurrently, see the next test).
      await expect(
        events.create(run.runId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: {} },
        })
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });

    it('should reject hook_received with RunExpiredError when the run terminates after hook_received earlier checks (linearization guard)', async () => {
      // Reproduces the race the transactional guard defends against:
      // hook_received's earlier currentRun/hook-exists checks pass while
      // the run is still running, then the run reaches a terminal state
      // before hook_received's guarded transaction commits. Updating the
      // run row directly (bypassing events.create's hook/wait cleanup)
      // reproduces exactly that ordering without deleting the hook,
      // isolating the assertion to the FOR UPDATE re-check inside the
      // hook_received transaction.
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      const hook = await createHook(events, run.runId, {
        hookId: 'hook_race_terminal',
        token: 'token-race-terminal',
      });

      await drizzle
        .update(DrizzleSchema.runs)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(DrizzleSchema.runs.runId, run.runId));

      await expect(
        events.create(run.runId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: {} },
        })
      ).rejects.toMatchObject({ name: 'RunExpiredError' });
    });

    it('accepts hook_received on a live legacy run', async () => {
      // Legacy runs (specVersion <= 1) are routed to
      // handleLegacyEventPostgres, which bypasses the current-spec guard
      // chain — the guard must be applied there too. Simulated by
      // downgrading a real run's persisted specVersion.
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'legacy-workflow',
        input: new Uint8Array(),
      });
      await drizzle
        .update(DrizzleSchema.runs)
        .set({ specVersion: 1 })
        .where(eq(DrizzleSchema.runs.runId, run.runId));

      const result = await events.create(run.runId, {
        eventType: 'hook_received',
        correlationId: 'hook_legacy_live',
        eventData: { payload: {} },
      });
      expect(result.event?.eventType).toBe('hook_received');
    });

    it('rejects hook_received with RunExpiredError on a cancelled legacy run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'legacy-workflow',
        input: new Uint8Array(),
      });
      await drizzle
        .update(DrizzleSchema.runs)
        .set({ specVersion: 1 })
        .where(eq(DrizzleSchema.runs.runId, run.runId));

      // Routed to the legacy run_cancelled handler (direct state update).
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        events.create(run.runId, {
          eventType: 'hook_received',
          correlationId: 'hook_legacy_cancelled',
          eventData: { payload: {} },
        })
      ).rejects.toMatchObject({ name: 'RunExpiredError' });
    });
  });

  describe('idempotent operations', () => {
    it('should allow run_cancelled on already cancelled run (idempotent)', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      // Should succeed - idempotent operation
      const result = await events.create(run.runId, {
        eventType: 'run_cancelled',
      });
      expect(result.run?.status).toBe('cancelled');
    });
  });

  describe('step_retrying event handling', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    it('should set step status to pending and record error', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_1',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(events, testRunId, 'step_retry_1', 'step_started');

      // The `error` field is opaque SerializedData (Uint8Array) produced by
      // dehydrateStepError. The storage layer persists it verbatim.
      const serializedError = new Uint8Array([9, 9, 9]);
      const result = await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_1',
        eventData: {
          error: serializedError,
          retryAfter: new Date(Date.now() + 5000),
        },
      });

      expect(result.step?.status).toBe('pending');
      expect(result.step?.error).toEqual(serializedError);
      expect(result.step?.retryAfter).toBeInstanceOf(Date);
    });

    it('should increment attempt when step_started is called after step_retrying', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: new Uint8Array(),
      });

      // First attempt
      const started1 = await updateStep(
        events,
        testRunId,
        'step_retry_2',
        'step_started'
      );
      expect(started1.attempt).toBe(1);

      // Retry
      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_2',
        eventData: { error: 'Temporary failure' },
      });

      // Second attempt
      const started2 = await updateStep(
        events,
        testRunId,
        'step_retry_2',
        'step_started'
      );
      expect(started2.attempt).toBe(2);
    });

    it('should reject step_retrying on completed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_completed',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(
        events,
        testRunId,
        'step_retry_completed',
        'step_completed',
        {
          result: new Uint8Array([1]),
        }
      );

      await expect(
        events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step_retry_completed',
          eventData: { error: 'Should not work' },
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_retrying on failed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_failed',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(events, testRunId, 'step_retry_failed', 'step_failed', {
        error: 'Permanent failure',
      });

      await expect(
        events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step_retry_failed',
          eventData: { error: 'Should not work' },
        })
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('run cancellation with in-flight entities', () => {
    it('should allow in-progress step to complete after run cancelled', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create and start a step
      await createStep(events, run.runId, {
        stepId: 'step_in_flight',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(events, run.runId, 'step_in_flight', 'step_started');

      // Cancel the run
      await events.create(run.runId, { eventType: 'run_cancelled' });

      // Should succeed - completing an in-progress step is allowed
      const result = await updateStep(
        events,
        run.runId,
        'step_in_flight',
        'step_completed',
        { result: new Uint8Array([1]) }
      );
      expect(result.status).toBe('completed');
    });

    it('should reject step_created after run cancelled', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_after_cancel',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started for pending step after run cancelled', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create a step but don't start it
      await createStep(events, run.runId, {
        stepId: 'pending_after_cancel',
        stepName: 'test-step',
        input: new Uint8Array(),
      });

      // Cancel the run
      await events.create(run.runId, { eventType: 'run_cancelled' });

      // Should reject - cannot start a pending step on a cancelled run
      await expect(
        updateStep(events, run.runId, 'pending_after_cancel', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('event ordering validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    it('should reject step_completed before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'nonexistent_step',
          eventData: { result: new Uint8Array([1]) },
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_started before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'nonexistent_step_started',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_failed before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'nonexistent_step_failed',
          eventData: { error: 'Failed' },
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should allow step_completed without step_started (instant completion)', async () => {
      await createStep(events, testRunId, {
        stepId: 'instant_complete',
        stepName: 'test-step',
        input: new Uint8Array(),
      });

      // Should succeed - instant completion without starting
      const result = await updateStep(
        events,
        testRunId,
        'instant_complete',
        'step_completed',
        { result: new Uint8Array([1]) }
      );
      expect(result.status).toBe('completed');
    });

    // A resume racing its hook's disposal must never be journaled AFTER
    // hook_disposed. Once that order is in the log, no replay of the owning run
    // can consume the delivery — the run retired that hook's consumer at the
    // disposal — so it strands, every replay reports divergence, and the run
    // escalates to CorruptedEventLogError. See vercel/workflow#2781, which
    // fixed the same ordering for world-local.
    describe('hook_received vs. hook_disposed ordering (#2781)', () => {
      const eventTypesFor = async (runId: string) => {
        const listed = await events.list({ runId, pagination: {} });
        return listed.data.map((event) => event.eventType);
      };

      it('rejects hook_received once the disposal has committed', async () => {
        const hook = await createHook(events, testRunId, {
          hookId: 'hook_order_after_dispose',
          token: 'order-after-dispose',
        });
        await events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: new Uint8Array([1]) },
        });
        await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: hook.hookId,
        });

        await expect(
          events.create(testRunId, {
            eventType: 'hook_received',
            correlationId: hook.hookId,
            eventData: { payload: new Uint8Array([2]) },
          })
        ).rejects.toMatchObject({ name: 'HookNotFoundError' });

        // Asserted on the log, not only on the throw: a rejection that still
        // journaled the row would leave the run corrupted exactly as before.
        expect(await eventTypesFor(testRunId)).toEqual([
          'run_created',
          'hook_created',
          'hook_received',
          'hook_disposed',
        ]);
      });

      it('rejects a resume that passed its unlocked check mid-disposal', async () => {
        // The regression guard. The unlocked existence read near the top of
        // `create` cannot see a disposal that commits after it, so what has to
        // hold is the locked re-check inside hook_received's transaction.
        //
        // Forced deterministically: an outside transaction takes the hook's row
        // lock (as the disposal's DELETE does) and holds it while the resume
        // runs. With the re-check in place the resume blocks on that lock and,
        // once the holder deletes and commits, observes the hook gone. Without
        // it the resume never takes the lock and journals its hook_received
        // while the hook is being deleted — the ordering this rejects.
        //
        // The holder needs its OWN pool: the suite's pool is `max: 1`, so
        // sharing it would make the resume wait for a free connection instead of
        // for the row lock, and the test would pass whether or not the re-check
        // exists.
        const hook = await createHook(events, testRunId, {
          hookId: 'hook_order_mid_dispose',
          token: 'order-mid-dispose',
        });

        const holderPool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
        });
        let signalLocked!: () => void;
        const locked = new Promise<void>((resolve) => {
          signalLocked = resolve;
        });
        let releaseHolder!: () => void;
        const release = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });

        try {
          const holder = createClient(holderPool).transaction(async (tx) => {
            await tx
              .select({ hookId: DrizzleSchema.hooks.hookId })
              .from(DrizzleSchema.hooks)
              .where(eq(DrizzleSchema.hooks.hookId, hook.hookId))
              .for('update')
              .limit(1);
            signalLocked();
            await release;
            await tx
              .delete(DrizzleSchema.hooks)
              .where(eq(DrizzleSchema.hooks.hookId, hook.hookId));
          });

          await locked;
          const resume = events.create(testRunId, {
            eventType: 'hook_received',
            correlationId: hook.hookId,
            eventData: { payload: new Uint8Array([1]) },
          });
          // Long enough for the resume to clear the unlocked check and reach the
          // locked one, where it blocks until the holder commits.
          await new Promise((resolve) => setTimeout(resolve, 250));
          releaseHolder();
          await holder;

          await expect(resume).rejects.toMatchObject({
            name: 'HookNotFoundError',
          });
        } finally {
          await holderPool.end();
        }

        expect(await eventTypesFor(testRunId)).toEqual([
          'run_created',
          'hook_created',
        ]);
      });

      it('still accepts a hook_received while the hook is live', async () => {
        // The lock must not reject an ordinary delivery: nothing holds the
        // hook's row while it is alive, so the re-check finds it every time.
        const hook = await createHook(events, testRunId, {
          hookId: 'hook_order_live',
          token: 'order-live',
        });

        const first = await events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: new Uint8Array([1]) },
        });
        const second = await events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hook.hookId,
          eventData: { payload: new Uint8Array([2]) },
        });

        expect(first.event.eventType).toBe('hook_received');
        expect(second.event.eventType).toBe('hook_received');
        expect(await eventTypesFor(testRunId)).toEqual([
          'run_created',
          'hook_created',
          'hook_received',
          'hook_received',
        ]);
      });

      it('appends hook_disposed and deletes the hook together', async () => {
        // The disposal's own half of the guard: the delete and the event are one
        // transaction, so the log never holds a disposal whose hook survived,
        // nor a deleted hook whose disposal is missing.
        const hook = await createHook(events, testRunId, {
          hookId: 'hook_order_atomic_dispose',
          token: 'order-atomic-dispose',
        });

        const disposed = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: hook.hookId,
        });

        expect(disposed.event.eventType).toBe('hook_disposed');
        const rows = await drizzle
          .select({ hookId: DrizzleSchema.hooks.hookId })
          .from(DrizzleSchema.hooks)
          .where(eq(DrizzleSchema.hooks.hookId, hook.hookId));
        expect(rows).toHaveLength(0);
      });
    });

    it('should reject hook_disposed before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'nonexistent_hook',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_received before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'nonexistent_hook_received',
          eventData: { payload: new Uint8Array() },
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('legacy/backwards compatibility', () => {
    // Helper to create a legacy run directly in the database (bypassing events.create)
    // Column mapping: id (runId), deployment_id, name (workflowName), spec_version, status, input
    async function createLegacyRun(runId: string, specVersion: number | null) {
      await pool.query(
        `INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, created_at, updated_at)
        VALUES ($1, 'legacy-deployment', 'legacy-workflow', $2, 'running', '[]'::jsonb, NOW(), NOW())`,
        [runId, specVersion]
      );
    }

    describe('legacy runs (specVersion < 2 or null)', () => {
      it('should handle run_cancelled on legacy run with specVersion=1', async () => {
        const runId = 'wrun_legacy_v1';
        await createLegacyRun(runId, 1);

        const result = await events.create(runId, {
          eventType: 'run_cancelled',
        });

        // Legacy behavior: run is updated but event is not stored
        expect(result.run?.status).toBe('cancelled');
        expect(result.event).toBeUndefined();
      });

      it('should handle run_cancelled on legacy run with specVersion=null', async () => {
        const runId = 'wrun_legacy_null';
        await createLegacyRun(runId, null);

        const result = await events.create(runId, {
          eventType: 'run_cancelled',
        });

        // Legacy behavior: run is updated but event is not stored
        expect(result.run?.status).toBe('cancelled');
        expect(result.event).toBeUndefined();
      });

      it('should handle wait_completed on legacy run', async () => {
        const runId = 'wrun_legacy_wait';
        await createLegacyRun(runId, 1);

        const result = await events.create(runId, {
          eventType: 'wait_completed',
          correlationId: 'wait_123',
          eventData: { result: new Uint8Array([1]) },
        } as any);

        // Legacy behavior: event is stored but no entity mutation
        expect(result.event).toBeDefined();
        expect(result.event?.eventType).toBe('wait_completed');
        expect(result.run).toBeUndefined();
      });

      it('should handle hook_received on legacy run', async () => {
        const runId = 'wrun_legacy_hook_received';
        await createLegacyRun(runId, 1);

        const result = await events.create(runId, {
          eventType: 'hook_received',
          correlationId: 'hook_123',
          eventData: { payload: new Uint8Array([1, 2, 3]) },
        } as any);

        // Legacy behavior: event is stored but no entity mutation
        // (hooks exist via old system, not via events)
        expect(result.event).toBeDefined();
        expect(result.event?.eventType).toBe('hook_received');
        expect(result.event?.correlationId).toBe('hook_123');
        expect(result.hook).toBeUndefined();
      });

      it('should reject unsupported events on legacy runs', async () => {
        const runId = 'wrun_legacy_unsupported';
        await createLegacyRun(runId, 1);

        // run_started is not supported for legacy runs
        await expect(
          events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/not supported for legacy runs/i);

        // run_completed is not supported for legacy runs
        await expect(
          events.create(runId, {
            eventType: 'run_completed',
            eventData: { output: new Uint8Array([1]) },
          })
        ).rejects.toThrow(/not supported for legacy runs/i);

        // run_failed is not supported for legacy runs
        await expect(
          events.create(runId, {
            eventType: 'run_failed',
            eventData: { error: 'failed' },
          })
        ).rejects.toThrow(/not supported for legacy runs/i);
      });

      it('should delete hooks when legacy run is cancelled', async () => {
        const runId = 'wrun_legacy_hooks';
        await createLegacyRun(runId, 1);

        // Create a hook directly in the database for this run
        await pool.query(
          `INSERT INTO workflow.workflow_hooks (hook_id, run_id, token, owner_id, project_id, environment, created_at)
          VALUES ('hook_legacy', $1, 'legacy-token', 'owner', 'project', 'test', NOW())`,
          [runId]
        );

        // Verify hook exists
        const hookBefore = await pool.query(
          `SELECT hook_id FROM workflow.workflow_hooks WHERE hook_id = 'hook_legacy'`
        );
        expect(hookBefore.rows[0]).toBeDefined();

        // Cancel the legacy run
        await events.create(runId, { eventType: 'run_cancelled' });

        // Hook should be deleted
        const hookAfter = await pool.query(
          `SELECT hook_id FROM workflow.workflow_hooks WHERE hook_id = 'hook_legacy'`
        );
        expect(hookAfter.rows[0]).toBeUndefined();
      });
    });

    describe('newer runs (specVersion > current)', () => {
      it('should reject events on runs with newer specVersion', async () => {
        const runId = 'wrun_future';
        // Create a run with a future spec version (higher than current)
        await pool.query(
          `INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, created_at, updated_at)
          VALUES ($1, 'future-deployment', 'future-workflow', 999, 'running', '[]'::jsonb, NOW(), NOW())`,
          [runId]
        );

        await expect(
          events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/requires spec version 999/i);
      });
    });

    describe('current version runs', () => {
      it('should process events normally for current specVersion runs', async () => {
        // Create run via events.create (gets current specVersion)
        const run = await createRun(events, {
          deploymentId: 'current-deployment',
          workflowName: 'current-workflow',
          input: new Uint8Array(),
        });

        // Should work normally
        const result = await events.create(run.runId, {
          eventType: 'run_started',
        });

        expect(result.run?.status).toBe('running');
        expect(result.event?.eventType).toBe('run_started');
      });
    });

    describe('legacy error column handling', () => {
      // In the current event-sourced model, the `error` field on runs/steps
      // is SerializedData (Uint8Array) produced by dehydrate*Error, stored in
      // the `error_cbor` column. Legacy records written pre-serialization-
      // pipeline (to the `error` text column) cannot be hydrated into the
      // original thrown value and are surfaced as `undefined` on read.
      it('should surface legacy errorJson field on runs as undefined', async () => {
        const runId = 'wrun_legacy_error';
        const inputCbor = encode(new Uint8Array());
        await pool.query(
          `INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input_cbor, error, created_at, updated_at, completed_at)
          VALUES ($1, 'deployment', 'workflow', 2, 'failed', $2, $3, NOW(), NOW(), NOW())`,
          [runId, inputCbor, '{"message":"Legacy error","stack":"at foo()"}']
        );

        const run = await runs.get(runId);
        expect(run.status).toBe('failed');
        expect(run.error).toBeUndefined();
      });

      it('should surface legacy errorJson on steps as undefined', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment',
          workflowName: 'workflow',
          input: new Uint8Array(),
        });

        const inputCbor = encode(new Uint8Array());
        await pool.query(
          `INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, status, input_cbor, error, attempt, created_at, updated_at, completed_at)
          VALUES ($1, 'step_legacy_err', 'test-step', 'failed', $2, $3, 1, NOW(), NOW(), NOW())`,
          [run.runId, inputCbor, '{"message":"Step error","stack":"at bar()"}']
        );

        const step = await steps.get(run.runId, 'step_legacy_err');
        expect(step.status).toBe('failed');
        expect(step.error).toBeUndefined();
      });
    });
  });
});
