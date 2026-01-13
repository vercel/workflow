import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
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

        const run = await runs.create(runData);

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

        const run = await runs.create(runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await runs.create({
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

    describe('update', () => {
      it('should update run status to running', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'running',
        });
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'completed',
          output: [{ result: 42 }],
        });
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });

      it('should update run status to failed', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'failed',
          error: {
            message: 'Something went wrong',
            code: 'ERR_001',
          },
        });

        expect(updated.status).toBe('failed');
        expect(updated.error).toEqual({
          message: 'Something went wrong',
          code: 'ERR_001',
        });
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should throw error for non-existent run', async () => {
        await expect(
          runs.update('missing', { status: 'running' })
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps in createdAt
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await runs.create({
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
        await runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await runs.create({
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
          await runs.create({
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

    describe('cancel', () => {
      it('should cancel a run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const cancelled = await runs.cancel(created.runId);

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await runs.create({
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

        const step = await steps.create(testRunId, stepData);

        expect(step).toEqual({
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
        });
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await steps.create(testRunId, {
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

    describe('update', () => {
      it('should update step status to running', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await steps.update(testRunId, 'step-123', {
          status: 'running',
        });

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update step status to completed', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await steps.update(testRunId, 'step-123', {
          status: 'completed',
          output: ['ok'],
        });

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });

      it('should update step status to failed', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await steps.update(testRunId, 'step-123', {
          status: 'failed',
          error: {
            message: 'Step failed',
            code: 'STEP_ERR',
          },
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.error?.code).toBe('STEP_ERR');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update attempt count', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await steps.update(testRunId, 'step-123', {
          attempt: 2,
        });

        expect(updated.attempt).toBe(2);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await steps.create(testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: [],
        });
        const step2 = await steps.create(testRunId, {
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
          await steps.create(testRunId, {
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
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const event = await events.create(testRunId, eventData);

        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_started');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        const event = await events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'corr_123',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_failed');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });

      it('should handle workflow completed events', async () => {
        const eventData = {
          eventType: 'workflow_completed' as const,
        };

        const event = await events.create(testRunId, eventData);

        expect(event.eventType).toBe('workflow_completed');
        expect(event.correlationId).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const event1 = await events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' }, // Explicitly request ascending order
        });

        expect(result.data).toHaveLength(2);
        // Should be in chronological order (oldest first)
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[0].createdAt.getTime()
        );
      });

      it('should list events in descending order when explicitly requested (newest first)', async () => {
        const event1 = await events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        expect(result.data).toHaveLength(2);
        // Should be in reverse chronological order (newest first)
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create multiple events
        for (let i = 0; i < 5; i++) {
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

        // Create events with the target correlation ID
        const event1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        // Create events with different correlation IDs (should be filtered out)
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

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[0].correlationId).toBe(correlationId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].correlationId).toBe(correlationId);
      });

      it('should list events across multiple runs with same correlation ID', async () => {
        const correlationId = 'hook-xyz789';

        // Create another run
        const run2 = await runs.create({
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        // Create events in both runs with same correlation ID
        const event1 = await events.create(testRunId, {
          eventType: 'hook_created',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(run2.runId, {
          eventType: 'hook_received',
          correlationId,
          eventData: { payload: { data: 'test' } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event3 = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[0].runId).toBe(testRunId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].runId).toBe(run2.runId);
        expect(result.data[2].eventId).toBe(event3.eventId);
        expect(result.data[2].runId).toBe(testRunId);
      });

      it('should return empty list for non-existent correlation ID', async () => {
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

        // Create multiple events
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId,
          eventData: { attempt: 1 },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        // Get first page
        const page1 = await events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        // Get second page
        const page2 = await events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });

      it('should always return full event data', async () => {
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

        expect(result.data).toHaveLength(1);
        expect(result.data[0].correlationId).toBe('step-with-data');
      });

      it('should return events in ascending order by default', async () => {
        const correlationId = 'step-ordering';

        // Create events with slight delays to ensure different timestamps
        const event1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[0].createdAt.getTime()).toBeLessThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support descending order', async () => {
        const correlationId = 'step-desc-order';

        const event1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: { sortOrder: 'desc' },
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should handle hook lifecycle events', async () => {
        const hookId = 'hook_test123';

        // Create a typical hook lifecycle
        const created = await events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: hookId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received1 = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received2 = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const disposed = await events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: hookId,
        });

        const result = await events.listByCorrelationId({
          correlationId: hookId,
          pagination: {},
        });

        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventId).toBe(created.eventId);
        expect(result.data[0].eventType).toBe('hook_created');
        expect(result.data[1].eventId).toBe(received1.eventId);
        expect(result.data[1].eventType).toBe('hook_received');
        expect(result.data[2].eventId).toBe(received2.eventId);
        expect(result.data[2].eventType).toBe('hook_received');
        expect(result.data[3].eventId).toBe(disposed.eventId);
        expect(result.data[3].eventType).toBe('hook_disposed');
      });
    });
  });
});
