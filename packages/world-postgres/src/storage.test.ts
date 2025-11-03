import { execSync } from 'node:child_process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from './drizzle/index.js';
import { createRunsStorage, createStepsStorage } from './storage.js';

describe('Storage (Postgres integration)', () => {
  const connectionString =
    process.env.WORKFLOW_POSTGRES_URL ||
    'postgres://world:world@localhost:5432/world';

  const sql = postgres(connectionString, { max: 1 });
  const drizzle = createClient(sql);
  const runs = createRunsStorage(drizzle);
  const steps = createStepsStorage(drizzle);

  async function truncateTables() {
    await sql`TRUNCATE TABLE workflow_events, workflow_steps, workflow_hooks, workflow_runs RESTART IDENTITY CASCADE`;
  }

  beforeAll(async () => {
    // Ensure schema is applied
    process.env.DATABASE_URL = connectionString;
    process.env.WORKFLOW_POSTGRES_URL = connectionString;
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await sql.end();
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
        expect(run.errorCode).toBeUndefined();
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

        const updated = await runs.update(created.runId, { status: 'running' });
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
          error: 'boom',
          errorCode: 'E_FAIL',
        });
        expect(updated.status).toBe('failed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.error).toBe('boom');
        expect(updated.errorCode).toBe('E_FAIL');
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

        const run2 = await runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await runs.list();
        expect(result.data.map((r) => r.runId)).toEqual(
          [run1.runId, run2.runId].sort().reverse()
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

    describe('pause', () => {
      it('should pause a run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        const paused = await runs.pause(created.runId);
        expect(paused.status).toBe('paused');
      });
    });

    describe('resume', () => {
      it('should resume a paused run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.pause(created.runId);
        const resumed = await runs.resume(created.runId);
        expect(resumed.status).toBe('running');
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
        const stepData = { stepId: 'step-123', stepName: 'first', input: [] };
        const step = await steps.create(testRunId, stepData);

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step-123');
        expect(step.status).toBe('pending');
        expect(step.attempt).toBe(1);
        expect(step.output).toBeUndefined();
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: [],
        });

        const retrieved = await steps.get(testRunId, created.stepId);

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: [],
        });

        const retrieved = await steps.get(undefined, created.stepId);

        expect(retrieved.stepId).toBe(created.stepId);
        expect(retrieved.runId).toBe(testRunId);
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
          input: [],
        });
        const updated = await steps.update(testRunId, 'step-123', {
          status: 'failed',
          error: 'bad',
          errorCode: 'X',
        });
        expect(updated.status).toBe('failed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.error).toBe('bad');
        expect(updated.errorCode).toBe('X');
      });

      it('should update attempt count', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: [],
        });
        const updated = await steps.update(testRunId, 'step-123', {
          attempt: 2,
        });
        expect(updated.attempt).toBe(2);
      });
    });
  });
});
