import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Hook, Step, WorkflowRun } from '@workflow/world';
import postgres from 'postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import {
  createEventsStorage,
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
    input: unknown[];
    executionContext?: Record<string, unknown>;
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
    input: unknown[];
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
  data: {
    hookId: string;
    token: string;
    metadata?: unknown;
  }
): Promise<Hook> {
  const result = await events.create(runId, {
    eventType: 'hook_created',
    correlationId: data.hookId,
    eventData: { token: data.token, metadata: data.metadata },
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
  let sql: ReturnType<typeof postgres>;
  let drizzle: ReturnType<typeof createClient>;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;

  async function truncateTables() {
    await sql`TRUNCATE TABLE workflow.workflow_events, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs RESTART IDENTITY CASCADE`;
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
    sql = postgres(dbUrl, { max: 1 });
    drizzle = createClient(sql);
    runs = createRunsStorage(drizzle);
    steps = createStepsStorage(drizzle);
    events = createEventsStorage(drizzle);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  describe('runs', () => {
    describe('create', () => {
      it('should create a new workflow run', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          executionContext: { userId: 'user-1' },
          input: ['arg1', 'arg2'],
        };

        const run = await createRun(events, runData);

        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe('deployment-123');
        expect(run.status).toBe('pending');
        expect(run.workflowName).toBe('test-workflow');
        expect(run.executionContext).toEqual({ userId: 'user-1' });
        expect(run.input).toEqual(['arg1', 'arg2']);
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
          input: [],
        };

        const run = await createRun(events, runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: ['arg'],
        });

        const retrieved = await runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe('test-workflow');
        expect(retrieved.input).toEqual(['arg']);
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(events, created.runId, 'run_started');
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed via run_completed event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(
          events,
          created.runId,
          'run_completed',
          {
            output: [{ result: 42 }],
          }
        );
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });

      it('should update run status to failed via run_failed event', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(events, created.runId, 'run_failed', {
          error: 'Something went wrong',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Something went wrong');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun(events, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps in createdAt
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
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
          input: [],
        });
        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
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
            input: [],
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
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        };

        const step = await createStep(events, testRunId, stepData);

        expect(step).toMatchObject({
          runId: testRunId,
          stepId: 'step-123',
          stepName: 'test-step',
          status: 'pending',
          input: ['input1', 'input2'],
          output: undefined,
          error: undefined,
          attempt: 0, // steps are created with attempt 0
          startedAt: undefined,
          completedAt: undefined,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          specVersion: 2,
        });
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await createStep(events, testRunId, {
          stepId: 'unique-step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(undefined, 'unique-step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(
          steps.get(testRunId, 'missing-step')
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('update via events', () => {
      it('should update step status to running via step_started event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
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

      it('should update step status to completed via step_completed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_completed',
          { result: ['ok'] }
        );

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });

      it('should update step status to failed via step_failed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_failed',
          { error: 'Step failed' }
        );

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await createStep(events, testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: [],
        });
        const step2 = await createStep(events, testRunId, {
          stepId: 'step-2',
          stepName: 'second-step',
          input: [],
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
            input: [],
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
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
          input: [],
        });

        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const result = await events.create(testRunId, eventData);

        expect(result.event.runId).toBe(testRunId);
        expect(result.event.eventId).toMatch(/^wevt_/);
        expect(result.event.eventType).toBe('step_started');
        expect(result.event.correlationId).toBe('corr_123');
        expect(result.event.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        // Create step before step_failed event
        await createStep(events, testRunId, {
          stepId: 'corr_123_null',
          stepName: 'test-step-null',
          input: [],
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
        expect(result.event.eventId).toMatch(/^wevt_/);
        expect(result.event.eventType).toBe('step_failed');
        expect(result.event.correlationId).toBe('corr_123_null');
        expect(result.event.createdAt).toBeInstanceOf(Date);
      });

      it('should handle workflow completed events', async () => {
        const eventData = {
          eventType: 'workflow_completed' as const,
        };

        const result = await events.create(testRunId, eventData);

        expect(result.event.eventType).toBe('workflow_completed');
        expect(result.event.correlationId).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const result1 = await events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: [],
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' }, // Explicitly request ascending order
        });

        // 4 events: run_created (from createRun), workflow_started, step_created, step_started
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
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create step before step_started event
        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: [],
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        // 4 events: run_created (from createRun), workflow_started, step_created, step_started
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
            input: [],
          });
          // Start the step before completing
          await events.create(testRunId, {
            eventType: 'step_started',
            correlationId: `corr_${i}`,
          });
          await events.create(testRunId, {
            eventType: 'step_completed',
            correlationId: `corr_${i}`,
            eventData: { result: i },
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
    });

    describe('listByCorrelationId', () => {
      it('should list all events with a specific correlation ID', async () => {
        const correlationId = 'step-abc123';

        // Create step before step events
        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
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
          eventData: { result: 'success' },
        });

        // Create events with different correlation IDs (should be filtered out)
        await createStep(events, testRunId, {
          stepId: 'different-step',
          stepName: 'different-step',
          input: [],
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'different-step',
        });
        await events.create(testRunId, {
          eventType: 'workflow_completed',
        });

        const result = await events.listByCorrelationId({
          correlationId,
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

      it('should list events across multiple runs with same correlation ID', async () => {
        const correlationId = 'hook-xyz789';

        // Create another run
        const run2 = await createRun(events, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
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
          eventData: { payload: { data: 'test' } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result3 = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventId).toBe(result1.event.eventId);
        expect(result.data[0].runId).toBe(testRunId);
        expect(result.data[1].eventId).toBe(result2.event.eventId);
        expect(result.data[1].runId).toBe(run2.runId);
        expect(result.data[2].eventId).toBe(result3.event.eventId);
        expect(result.data[2].runId).toBe(testRunId);
      });

      it('should return empty list for non-existent correlation ID', async () => {
        // Create a step and start it
        await createStep(events, testRunId, {
          stepId: 'existing-step',
          stepName: 'existing-step',
          input: [],
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'existing-step',
        });

        const result = await events.listByCorrelationId({
          correlationId: 'non-existent-correlation-id',
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
          input: [],
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
          eventData: { result: 'success' },
        });

        // Get first page (step_created, step_started, step_retrying)
        const page1 = await events.listByCorrelationId({
          correlationId,
          pagination: { limit: 3 },
        });

        expect(page1.data).toHaveLength(3);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        // Get second page (step_started, step_completed)
        const page2 = await events.listByCorrelationId({
          correlationId,
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
          input: [],
        });
        // Start the step before completing
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-with-data',
        });
        await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-with-data',
          eventData: { result: 'success' },
        });

        // Note: resolveData parameter is ignored by the PG World storage implementation
        const result = await events.listByCorrelationId({
          correlationId: 'step-with-data',
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
          input: [],
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
          eventData: { result: 'success' },
        });

        const result = await events.listByCorrelationId({
          correlationId,
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
          input: [],
        });

        const result1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const result2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await events.listByCorrelationId({
          correlationId,
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
          eventData: { payload: { request: 1 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received2Result = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const disposedResult = await events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: hookId,
        });

        const result = await events.listByCorrelationId({
          correlationId: hookId,
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
          input: [],
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
          input: [],
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

  describe('step terminal state validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('completed step', () => {
      it('should reject step_started on completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_terminal_1',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_1',
          'step_completed',
          {
            result: 'done',
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
          input: [],
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_2',
          'step_completed',
          {
            result: 'done',
          }
        );

        await expect(
          updateStep(events, testRunId, 'step_terminal_2', 'step_completed', {
            result: 'done again',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on completed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_terminal_3',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          events,
          testRunId,
          'step_terminal_3',
          'step_completed',
          {
            result: 'done',
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
          input: [],
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
          input: [],
        });
        await updateStep(events, testRunId, 'step_failed_2', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(events, testRunId, 'step_failed_2', 'step_completed', {
            result: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on already failed step', async () => {
        await createStep(events, testRunId, {
          stepId: 'step_failed_3',
          stepName: 'test-step',
          input: [],
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
          input: [],
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
          input: [],
        });
        await updateStep(
          events,
          testRunId,
          'step_completed_retry',
          'step_completed',
          {
            result: 'done',
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
          input: [],
        });
        await updateRun(events, run.runId, 'run_completed', { output: 'done' });

        await expect(
          updateRun(events, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on completed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(events, run.runId, 'run_completed', { output: 'done' });

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
          input: [],
        });
        await updateRun(events, run.runId, 'run_completed', { output: 'done' });

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
          input: [],
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
          input: [],
        });
        await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(events, run.runId, 'run_completed', {
            output: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on failed run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
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
          input: [],
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
          input: [],
        });
        await events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(events, run.runId, 'run_completed', {
            output: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on cancelled run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
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
        input: [],
      });

      // Create and start a step (making it in-progress)
      await createStep(events, run.runId, {
        stepId: 'step_in_progress',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, run.runId, 'step_in_progress', 'step_started');

      // Complete the run while step is still running
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

      // Should succeed - completing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        events,
        run.runId,
        'step_in_progress',
        'step_completed',
        { result: 'step done' }
      );
      expect(result.status).toBe('completed');
    });

    it('should allow step_failed on completed run for in-progress step', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create and start a step
      await createStep(events, run.runId, {
        stepId: 'step_in_progress_fail',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(
        events,
        run.runId,
        'step_in_progress_fail',
        'step_started'
      );

      // Complete the run
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

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
        input: [],
      });

      // Create a hook
      await createHook(events, run.runId, {
        hookId: 'hook_auto_deleted',
        token: 'test-token-dispose',
      });

      // Complete the run - this auto-deletes the hook
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

      // The hook should no longer exist because run completion auto-deletes hooks
      // This is intentional behavior to allow token reuse across runs
      await expect(
        events.create(run.runId, {
          eventType: 'hook_disposed',
          correlationId: 'hook_auto_deleted',
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('disallowed operations on terminal runs', () => {
    it('should reject step_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started on completed run for pending step', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a step but don't start it
      await createStep(events, run.runId, {
        stepId: 'pending_step',
        stepName: 'test-step',
        input: [],
      });

      // Complete the run
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

      // Should reject - cannot start a pending step on a terminal run
      await expect(
        updateStep(events, run.runId, 'pending_step', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: 'done' });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook',
          token: 'new-token',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on failed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_failed',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on cancelled run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_cancelled',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on failed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
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
        input: [],
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook_cancelled',
          token: 'new-token-cancelled',
        })
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('idempotent operations', () => {
    it('should allow run_cancelled on already cancelled run (idempotent)', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
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
        input: [],
      });
      testRunId = run.runId;
    });

    it('should set step status to pending and record error', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_1',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_retry_1', 'step_started');

      const result = await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_1',
        eventData: {
          error: 'Temporary failure',
          retryAfter: new Date(Date.now() + 5000),
        },
      });

      expect(result.step?.status).toBe('pending');
      expect(result.step?.error?.message).toBe('Temporary failure');
      expect(result.step?.retryAfter).toBeInstanceOf(Date);
    });

    it('should increment attempt when step_started is called after step_retrying', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: [],
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
        input: [],
      });
      await updateStep(
        events,
        testRunId,
        'step_retry_completed',
        'step_completed',
        {
          result: 'done',
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
        input: [],
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
        input: [],
      });

      // Create and start a step
      await createStep(events, run.runId, {
        stepId: 'step_in_flight',
        stepName: 'test-step',
        input: [],
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
        { result: 'done' }
      );
      expect(result.status).toBe('completed');
    });

    it('should reject step_created after run cancelled', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step_after_cancel',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started for pending step after run cancelled', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a step but don't start it
      await createStep(events, run.runId, {
        stepId: 'pending_after_cancel',
        stepName: 'test-step',
        input: [],
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
        input: [],
      });
      testRunId = run.runId;
    });

    it('should reject step_completed before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'nonexistent_step',
          eventData: { result: 'done' },
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
        input: [],
      });

      // Should succeed - instant completion without starting
      const result = await updateStep(
        events,
        testRunId,
        'instant_complete',
        'step_completed',
        { result: 'instant' }
      );
      expect(result.status).toBe('completed');
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
          eventData: { payload: {} },
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('legacy/backwards compatibility', () => {
    // Helper to create a legacy run directly in the database (bypassing events.create)
    // Column mapping: id (runId), deployment_id, name (workflowName), spec_version, status, input
    async function createLegacyRun(runId: string, specVersion: number | null) {
      await sql`
        INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, created_at, updated_at)
        VALUES (${runId}, 'legacy-deployment', 'legacy-workflow', ${specVersion}, 'running', '[]'::jsonb, NOW(), NOW())
      `;
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
          eventData: { result: 'waited' },
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
          eventData: { payload: { data: 'test' } },
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
            eventData: { output: 'done' },
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
        await sql`
          INSERT INTO workflow.workflow_hooks (hook_id, run_id, token, owner_id, project_id, environment, created_at)
          VALUES ('hook_legacy', ${runId}, 'legacy-token', 'owner', 'project', 'test', NOW())
        `;

        // Verify hook exists
        const [hookBefore] =
          await sql`SELECT hook_id FROM workflow.workflow_hooks WHERE hook_id = 'hook_legacy'`;
        expect(hookBefore).toBeDefined();

        // Cancel the legacy run
        await events.create(runId, { eventType: 'run_cancelled' });

        // Hook should be deleted
        const [hookAfter] =
          await sql`SELECT hook_id FROM workflow.workflow_hooks WHERE hook_id = 'hook_legacy'`;
        expect(hookAfter).toBeUndefined();
      });
    });

    describe('newer runs (specVersion > current)', () => {
      it('should reject events on runs with newer specVersion', async () => {
        const runId = 'wrun_future';
        // Create a run with a future spec version (higher than current)
        await sql`
          INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, created_at, updated_at)
          VALUES (${runId}, 'future-deployment', 'future-workflow', 999, 'running', '[]'::jsonb, NOW(), NOW())
        `;

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
          input: [],
        });

        // Should work normally
        const result = await events.create(run.runId, {
          eventType: 'run_started',
        });

        expect(result.run?.status).toBe('running');
        expect(result.event?.eventType).toBe('run_started');
      });
    });

    describe('legacy error parsing', () => {
      it('should parse legacy errorJson field on runs', async () => {
        const runId = 'wrun_legacy_error';
        // Create a run with legacy error format (error column is the text/JSON one)
        // Failed runs need completed_at set
        await sql`
          INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, error, created_at, updated_at, completed_at)
          VALUES (${runId}, 'deployment', 'workflow', 2, 'failed', '[]'::jsonb, '{"message":"Legacy error","stack":"at foo()"}', NOW(), NOW(), NOW())
        `;

        const run = await runs.get(runId);
        expect(run.error?.message).toBe('Legacy error');
        expect(run.error?.stack).toBe('at foo()');
      });

      it('should parse legacy errorJson as plain string', async () => {
        const runId = 'wrun_legacy_string_error';
        // Create a run with plain string error
        // Failed runs need completed_at set
        await sql`
          INSERT INTO workflow.workflow_runs (id, deployment_id, name, spec_version, status, input, error, created_at, updated_at, completed_at)
          VALUES (${runId}, 'deployment', 'workflow', 2, 'failed', '[]'::jsonb, '"Simple error message"', NOW(), NOW(), NOW())
        `;

        const run = await runs.get(runId);
        expect(run.error?.message).toBe('Simple error message');
      });

      it('should parse legacy errorJson field on steps', async () => {
        // First create a run and step
        const run = await createRun(events, {
          deploymentId: 'deployment',
          workflowName: 'workflow',
          input: [],
        });

        // Insert a step directly with legacy error format (error column is the text/JSON one)
        // Failed steps need completed_at set
        await sql`
          INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, status, input, error, attempt, created_at, updated_at, completed_at)
          VALUES (${run.runId}, 'step_legacy_err', 'test-step', 'failed', '[]'::jsonb, '{"message":"Step error","stack":"at bar()"}', 1, NOW(), NOW(), NOW())
        `;

        const step = await steps.get(run.runId, 'step_legacy_err');
        expect(step.error?.message).toBe('Step error');
        expect(step.error?.stack).toBe('at bar()');
      });
    });
  });
});
