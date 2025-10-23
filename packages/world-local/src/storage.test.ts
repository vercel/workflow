import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Storage } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from './storage.js';

describe('Storage', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    // Reset the ULID factory for each test to avoid state pollution
    monotonicFactory(() => Math.random());

    // Create a temporary directory for testing
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));

    storage = createStorage(testDir);
  });

  afterEach(async () => {
    // Clean up test dir
    await fs.rm(testDir, { recursive: true, force: true });
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

        const run = await storage.runs.create(runData);

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

        // Verify file was created
        const filePath = path.join(testDir, 'runs', `${run.runId}.json`);
        const fileExists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);
      });

      it('should handle minimal run data', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'minimal-workflow',
          input: [],
        };

        const run = await storage.runs.create(runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const retrieved = await storage.runs.get(created.runId);

        expect(retrieved).toEqual(created);
      });

      it('should throw error for non-existent run', async () => {
        await expect(storage.runs.get('wrun_nonexistent')).rejects.toThrow(
          'Workflow run "wrun_nonexistent" not found'
        );
      });
    });

    describe('update', () => {
      it('should update run status to running', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 1));

        const updated = await storage.runs.update(created.runId, {
          status: 'running',
        });

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
          created.updatedAt.getTime()
        );
      });

      it('should update run status to completed', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await storage.runs.update(created.runId, {
          status: 'completed',
          output: { result: 'success' },
        });

        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual({ result: 'success' });
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update run status to failed', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await storage.runs.update(created.runId, {
          status: 'failed',
          error: 'Something went wrong',
          errorCode: 'ERR_001',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('Something went wrong');
        expect(updated.errorCode).toBe('ERR_001');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should throw error for non-existent run', async () => {
        await expect(
          storage.runs.update('wrun_nonexistent', { status: 'running' })
        ).rejects.toThrow('Workflow run "wrun_nonexistent" not found');
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps in ULIDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await storage.runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThan(
          result.data[1].createdAt.getTime()
        );
      });

      it('should filter runs by workflowName', async () => {
        await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await storage.runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should support pagination', async () => {
        // Create multiple runs
        for (let i = 0; i < 5; i++) {
          await storage.runs.create({
            deploymentId: `deployment-${i}`,
            workflowName: `workflow-${i}`,
            input: [],
          });
        }

        const page1 = await storage.runs.list({
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.runs.list({
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].runId).not.toBe(page1.data[0].runId);
      });
    });

    describe('cancel', () => {
      it('should cancel a run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const cancelled = await storage.runs.cancel(created.runId);

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('pause', () => {
      it('should pause a run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const paused = await storage.runs.pause(created.runId);

        expect(paused.status).toBe('paused');
      });
    });

    describe('resume', () => {
      it('should resume a paused run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        await storage.runs.pause(created.runId);
        const resumed = await storage.runs.resume(created.runId);

        expect(resumed.status).toBe('running');
        expect(resumed.startedAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        };

        const step = await storage.steps.create(testRunId, stepData);

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step_123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.output).toBeUndefined();
        expect(step.error).toBeUndefined();
        expect(step.errorCode).toBeUndefined();
        expect(step.attempt).toBe(0);
        expect(step.startedAt).toBeUndefined();
        expect(step.completedAt).toBeUndefined();
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);

        // Verify file was created
        const filePath = path.join(
          testDir,
          'steps',
          `${testRunId}-step_123.json`
        );
        const fileExists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await storage.steps.create(testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await storage.steps.get(testRunId, 'step_123');

        expect(retrieved).toEqual(created);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await storage.steps.create(testRunId, {
          stepId: 'unique_step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await storage.steps.get(undefined, 'unique_step_123');

        expect(retrieved).toEqual(created);
      });

      it('should throw error for non-existent step', async () => {
        await expect(
          storage.steps.get(testRunId, 'nonexistent_step')
        ).rejects.toThrow('Step nonexistent_step in run');
      });
    });

    describe('update', () => {
      it('should update step status to running', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step_123', {
          status: 'running',
        });

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update step status to completed', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step_123', {
          status: 'completed',
          output: { result: 'done' },
        });

        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual({ result: 'done' });
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update step status to failed', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step_123', {
          status: 'failed',
          error: 'Step failed',
          errorCode: 'STEP_ERR',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('Step failed');
        expect(updated.errorCode).toBe('STEP_ERR');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update attempt count', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step_123', {
          attempt: 2,
        });

        expect(updated.attempt).toBe(2);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await storage.steps.create(testRunId, {
          stepId: 'step_1',
          stepName: 'first-step',
          input: [],
        });
        const step2 = await storage.steps.create(testRunId, {
          stepId: 'step_2',
          stepName: 'second-step',
          input: [],
        });

        const result = await storage.steps.list({
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
          await storage.steps.create(testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        const page1 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.steps.list({
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
      const run = await storage.runs.create({
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

        const event = await storage.events.create(testRunId, eventData);

        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^evnt_/);
        expect(event.eventType).toBe('step_started');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);

        // Verify file was created
        const filePath = path.join(
          testDir,
          'events',
          `${testRunId}-${event.eventId}.json`
        );
        const fileExists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);
      });

      it('should handle workflow completed events', async () => {
        const eventData = {
          eventType: 'workflow_completed' as const,
        };

        const event = await storage.events.create(testRunId, eventData);

        expect(event.eventType).toBe('workflow_completed');
        expect(event.correlationId).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const event1 = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr_step_1',
        });

        const result = await storage.events.list({
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
        const event1 = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr_step_1',
        });

        const result = await storage.events.list({
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
          await storage.events.create(testRunId, {
            eventType: 'step_completed' as const,
            correlationId: `corr_${i}`,
            eventData: { result: i },
          });
        }

        const page1 = await storage.events.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.events.list({
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
        const event1 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        // Create events with different correlation IDs (should be filtered out)
        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'different-step',
        });
        await storage.events.create(testRunId, {
          eventType: 'workflow_completed' as const,
        });

        const result = await storage.events.listByCorrelationId({
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
        const run2 = await storage.runs.create({
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        // Create events in both runs with same correlation ID
        const event1 = await storage.events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(run2.runId, {
          eventType: 'hook_received' as const,
          correlationId,
          eventData: { payload: { data: 'test' } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event3 = await storage.events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId,
        });

        const result = await storage.events.listByCorrelationId({
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
        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'existing-step',
        });

        const result = await storage.events.listByCorrelationId({
          correlationId: 'non-existent-correlation-id',
          pagination: {},
        });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.cursor).toBeNull();
      });

      it('should respect pagination parameters', async () => {
        const correlationId = 'step-paginated';

        // Create multiple events
        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await storage.events.create(testRunId, {
          eventType: 'step_retrying' as const,
          correlationId,
          eventData: { attempt: 1 },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        // Get first page
        const page1 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        // Get second page
        const page2 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });

      it('should filter event data when resolveData is "none"', async () => {
        const correlationId = 'step-with-data';

        await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
          resolveData: 'none',
        });

        expect(result.data).toHaveLength(1);
        expect((result.data[0] as any).eventData).toBeUndefined();
        expect(result.data[0].correlationId).toBe(correlationId);
      });

      it('should return events in ascending order by default', async () => {
        const correlationId = 'step-ordering';

        // Create events with slight delays to ensure different timestamps
        const event1 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
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

        const event1 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
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
        const created = await storage.events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: hookId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received1 = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const received2 = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const disposed = await storage.events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: hookId,
        });

        const result = await storage.events.listByCorrelationId({
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

  describe('hooks', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new hook', async () => {
        const hookData = {
          hookId: 'hook_123',
          token: 'my-hook-token',
        };

        const hook = await storage.hooks.create(testRunId, hookData);

        expect(hook.runId).toBe(testRunId);
        expect(hook.hookId).toBe('hook_123');
        expect(hook.token).toBe('my-hook-token');
        expect(hook.ownerId).toBe('embedded-owner');
        expect(hook.projectId).toBe('embedded-project');
        expect(hook.environment).toBe('embedded');
        expect(hook.createdAt).toBeInstanceOf(Date);

        // Verify file was created
        const filePath = path.join(testDir, 'hooks', 'hook_123.json');
        const fileExists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);
      });
    });

    describe('get', () => {
      it('should retrieve an existing hook by hookId', async () => {
        const created = await storage.hooks.create(testRunId, {
          hookId: 'hook_123',
          token: 'test-token-123',
        });

        const retrieved = await storage.hooks.get('hook_123');

        expect(retrieved).toEqual(created);
      });

      it('should throw error for non-existent hook', async () => {
        await expect(storage.hooks.get('nonexistent_hook')).rejects.toThrow(
          'Hook nonexistent_hook not found'
        );
      });

      it('should respect resolveData option', async () => {
        const created = await storage.hooks.create(testRunId, {
          hookId: 'hook_with_response',
          token: 'test-token',
        });

        // With resolveData: 'all', should include response
        const withData = await storage.hooks.get('hook_with_response', {
          resolveData: 'all',
        });
        expect(withData).toEqual(created);

        // With resolveData: 'none', should exclude response
        const withoutData = await storage.hooks.get('hook_with_response', {
          resolveData: 'none',
        });
        expect((withoutData as any).response).toBeUndefined();
        expect(withoutData.hookId).toBe('hook_with_response');
      });
    });

    describe('getByToken', () => {
      it('should retrieve an existing hook by token', async () => {
        const created = await storage.hooks.create(testRunId, {
          hookId: 'hook_123',
          token: 'test-token-123',
        });

        const retrieved = await storage.hooks.getByToken('test-token-123');

        expect(retrieved).toEqual(created);
      });

      it('should throw error for non-existent token', async () => {
        await expect(
          storage.hooks.getByToken('nonexistent-token')
        ).rejects.toThrow('Hook with token nonexistent-token not found');
      });

      it('should find the correct hook when multiple hooks exist', async () => {
        const hook1 = await storage.hooks.create(testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });
        await storage.hooks.create(testRunId, {
          hookId: 'hook_2',
          token: 'token-2',
        });
        await storage.hooks.create(testRunId, {
          hookId: 'hook_3',
          token: 'token-3',
        });

        const retrieved = await storage.hooks.getByToken('token-1');

        expect(retrieved).toEqual(hook1);
        expect(retrieved.hookId).toBe('hook_1');
      });
    });

    describe('list', () => {
      it('should list all hooks', async () => {
        const hook1 = await storage.hooks.create(testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });

        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));

        const hook2 = await storage.hooks.create(testRunId, {
          hookId: 'hook_2',
          token: 'token-2',
        });

        const result = await storage.hooks.list({});

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].hookId).toBe(hook2.hookId);
        expect(result.data[1].hookId).toBe(hook1.hookId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should filter hooks by runId', async () => {
        // Create a second run
        const run2 = await storage.runs.create({
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        await storage.hooks.create(testRunId, {
          hookId: 'hook_run1',
          token: 'token-run1',
        });
        const hook2 = await storage.hooks.create(run2.runId, {
          hookId: 'hook_run2',
          token: 'token-run2',
        });

        const result = await storage.hooks.list({ runId: run2.runId });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].hookId).toBe(hook2.hookId);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should support pagination', async () => {
        // Create multiple hooks
        for (let i = 0; i < 5; i++) {
          await storage.hooks.create(testRunId, {
            hookId: `hook_${i}`,
            token: `token-${i}`,
          });
        }

        const page1 = await storage.hooks.list({
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();
        expect(page1.hasMore).toBe(true);

        const page2 = await storage.hooks.list({
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].hookId).not.toBe(page1.data[0].hookId);
      });

      it('should support ascending sort order', async () => {
        const hook1 = await storage.hooks.create(testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const hook2 = await storage.hooks.create(testRunId, {
          hookId: 'hook_2',
          token: 'token-2',
        });

        const result = await storage.hooks.list({
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(2);
        // Should be in ascending order (oldest first)
        expect(result.data[0].hookId).toBe(hook1.hookId);
        expect(result.data[1].hookId).toBe(hook2.hookId);
      });

      it('should respect resolveData option', async () => {
        await storage.hooks.create(testRunId, {
          hookId: 'hook_with_response',
          token: 'token-with-response',
        });

        // With resolveData: 'all', should include response
        const withData = await storage.hooks.list({
          resolveData: 'all',
        });
        expect(withData.data).toHaveLength(1);

        // With resolveData: 'none', should exclude response
        const withoutData = await storage.hooks.list({
          resolveData: 'none',
        });
        expect(withoutData.data).toHaveLength(1);
        expect((withoutData.data[0] as any).response).toBeUndefined();
        expect(withoutData.data[0].hookId).toBe('hook_with_response');
      });

      it('should handle empty result set', async () => {
        const result = await storage.hooks.list({});

        expect(result.data).toHaveLength(0);
        expect(result.cursor).toBeNull();
        expect(result.hasMore).toBe(false);
      });
    });

    describe('dispose', () => {
      it('should delete an existing hook', async () => {
        const created = await storage.hooks.create(testRunId, {
          hookId: 'hook_to_delete',
          token: 'token-to-delete',
        });

        const disposed = await storage.hooks.dispose('hook_to_delete');

        expect(disposed).toEqual(created);

        // Verify file was deleted
        await expect(
          storage.hooks.getByToken('token-to-delete')
        ).rejects.toThrow('Hook with token token-to-delete not found');
      });

      it('should throw error for non-existent hook', async () => {
        await expect(storage.hooks.dispose('hook_nonexistent')).rejects.toThrow(
          'Hook hook_nonexistent not found'
        );
      });
    });
  });
});
