import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Storage } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from './storage.js';
import {
  createHook,
  createRun,
  createStep,
  disposeHook,
  updateRun,
  updateStep,
} from './test-helpers.js';

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

        const run = await createRun(storage, runData);

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

        const run = await createRun(storage, runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun(storage, {
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

    describe('update via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 1));

        const updated = await updateRun(storage, created.runId, 'run_started');

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
          created.updatedAt.getTime()
        );
      });

      it('should update run status to completed via run_completed event', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(
          storage,
          created.runId,
          'run_completed',
          {
            output: { result: 'success' },
          }
        );

        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual({ result: 'success' });
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update run status to failed via run_failed event', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(storage, created.runId, 'run_failed', {
          error: 'Something went wrong',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Something went wrong');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun(storage, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps in ULIDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await createRun(storage, {
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
        await createRun(storage, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await createRun(storage, {
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
          await createRun(storage, {
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
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
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

        const step = await createStep(storage, testRunId, stepData);

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step_123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.output).toBeUndefined();
        expect(step.error).toBeUndefined();
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
        const created = await createStep(storage, testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await storage.steps.get(testRunId, 'step_123');

        expect(retrieved).toEqual(created);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await createStep(storage, testRunId, {
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

    describe('update via events', () => {
      it('should update step status to running via step_started event', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          storage,
          testRunId,
          'step_123',
          'step_started',
          {} // step_started no longer needs attempt in eventData - World increments it
        );

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
        expect(updated.attempt).toBe(1); // Incremented by step_started
      });

      it('should update step status to completed via step_completed event', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          storage,
          testRunId,
          'step_123',
          'step_completed',
          { result: { result: 'done' } }
        );

        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual({ result: 'done' });
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update step status to failed via step_failed event', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          storage,
          testRunId,
          'step_123',
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
        const step1 = await createStep(storage, testRunId, {
          stepId: 'step_1',
          stepName: 'first-step',
          input: [],
        });
        const step2 = await createStep(storage, testRunId, {
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
          await createStep(storage, testRunId, {
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

      it('should handle pagination when new items are created after getting a cursor', async () => {
        // Create initial set of items (4 items)
        for (let i = 0; i < 4; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // Get first page with limit=4 (should return all 4 items)
        const page1 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4 },
        });

        expect(page1.data).toHaveLength(4);
        expect(page1.hasMore).toBe(false);
        // With the fix, cursor should be set to the last item even when hasMore is false
        expect(page1.cursor).not.toBeNull();

        // Now create 4 more items (total: 8 items)
        for (let i = 4; i < 8; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // Try to get the "next page" using the old cursor (which was null)
        // This should show that we can't continue from where we left off
        const page2 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4 },
        });

        // Should now return 4 items (the newest ones: step_7, step_6, step_5, step_4)
        expect(page2.data).toHaveLength(4);
        expect(page2.hasMore).toBe(true);

        // Get the next page using the cursor from page2
        const page3 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4, cursor: page2.cursor || undefined },
        });

        // Should return the older 4 items (step_3, step_2, step_1, step_0)
        expect(page3.data).toHaveLength(4);
        expect(page3.hasMore).toBe(false);

        // Verify no overlap
        const page2Ids = new Set(page2.data.map((s) => s.stepId));
        const page3Ids = new Set(page3.data.map((s) => s.stepId));

        for (const id of page3Ids) {
          expect(page2Ids.has(id)).toBe(false);
        }
      });

      it('should handle pagination with cursor after items are added mid-pagination', async () => {
        // Create initial 4 items
        for (let i = 0; i < 4; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // Get first page with limit=2
        const page1 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        const cursor1 = page1.cursor;

        // Get second page
        const page2 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: cursor1 || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.hasMore).toBe(false);
        const cursor2 = page2.cursor;

        // With the fix, cursor2 should NOT be null even when hasMore is false
        expect(cursor2).not.toBeNull();

        // Now add 4 more items (total: 8)
        for (let i = 4; i < 8; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // Try to continue with cursor2 (should return no items since we're at the end)
        // The cursor marks where we left off, so continuing from there should not return
        // the newly created items (which are newer than the cursor position)
        const page3 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: cursor2 || undefined },
        });

        expect(page3.data).toHaveLength(0);
        expect(page3.hasMore).toBe(false);

        // But if we use cursor1 again (from the first page), we should still get the next 2 items
        // This verifies that the cursor is stable and repeatable
        const page2Retry = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: cursor1 || undefined },
        });

        // Should return 2 items that come after cursor1 position
        // In descending order, these would be the next 2 oldest items
        expect(page2Retry.data).toHaveLength(2);

        // The items should be the same as page2 originally returned
        // (the cursor position is stable regardless of new items added)
        expect(page2Retry.data[0].stepId).toBe(page2.data[0].stepId);
        expect(page2Retry.data[1].stepId).toBe(page2.data[1].stepId);
      });

      it('should reproduce GitHub issue #298: pagination after reaching the end and creating new items', async () => {
        // This test reproduces the exact scenario from issue #298
        // https://github.com/vercel/workflow/issues/298

        // Start with X items (4 items)
        for (let i = 0; i < 4; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // First page contains X items if limit=X
        const firstPage = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4 },
        });

        expect(firstPage.data).toHaveLength(4);
        expect(firstPage.hasMore).toBe(false);
        const firstCursor = firstPage.cursor;

        // Cursor should be set even when we reached the end
        expect(firstCursor).not.toBeNull();

        // Create new items (total becomes 2X = 8 items)
        for (let i = 4; i < 8; i++) {
          await createStep(storage, testRunId, {
            stepId: `step_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
        }

        // Next page with cursor=<previous-request-cursor> should return 0 items
        // because the cursor marks where we left off, and there are no items
        // OLDER than the cursor position (in descending order)
        const nextPage = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4, cursor: firstCursor || undefined },
        });

        expect(nextPage.data).toHaveLength(0);
        expect(nextPage.hasMore).toBe(false);

        // If we start from the beginning (no cursor), we should get the newest 4 items
        const freshPage = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4 },
        });

        expect(freshPage.data).toHaveLength(4);
        expect(freshPage.hasMore).toBe(true);

        // The fresh page should contain the new items (step_7, step_6, step_5, step_4)
        expect(freshPage.data[0].stepId).toBe('step_7');
        expect(freshPage.data[1].stepId).toBe('step_6');
        expect(freshPage.data[2].stepId).toBe('step_5');
        expect(freshPage.data[3].stepId).toBe('step_4');

        // And the second page should contain the original items
        const secondPage = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 4, cursor: freshPage.cursor || undefined },
        });

        expect(secondPage.data).toHaveLength(4);
        expect(secondPage.data[0].stepId).toBe('step_3');
        expect(secondPage.data[1].stepId).toBe('step_2');
        expect(secondPage.data[2].stepId).toBe('step_1');
        expect(secondPage.data[3].stepId).toBe('step_0');
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // Create step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
          input: [],
        });

        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const { event } = await storage.events.create(testRunId, eventData);

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

        const { event } = await storage.events.create(testRunId, eventData);

        expect(event.eventType).toBe('workflow_completed');
        expect(event.correlationId).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        // Note: testRunId was created via createRun which creates a run_created event
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_step_1',
          stepName: 'test-step',
          input: [],
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr_step_1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' }, // Explicitly request ascending order
        });

        // 4 events: run_created (from createRun), workflow_started, step_created, step_started
        expect(result.data).toHaveLength(4);
        // Should be in chronological order (oldest first)
        expect(result.data[0].eventType).toBe('run_created');
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[2].eventType).toBe('step_created');
        expect(result.data[3].eventId).toBe(event2.eventId);
        expect(result.data[3].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[2].createdAt.getTime()
        );
      });

      it('should list events in descending order when explicitly requested (newest first)', async () => {
        // Note: testRunId was created via createRun which creates a run_created event
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_step_1',
          stepName: 'test-step',
          input: [],
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr_step_1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        // 4 events: run_created (from createRun), workflow_started, step_created, step_started
        expect(result.data).toHaveLength(4);
        // Should be in reverse chronological order (newest first)
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventType).toBe('step_created');
        expect(result.data[2].eventId).toBe(event1.eventId);
        expect(result.data[3].eventType).toBe('run_created');
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create steps first, then create step_completed events
        for (let i = 0; i < 5; i++) {
          await createStep(storage, testRunId, {
            stepId: `corr_${i}`,
            stepName: `step-${i}`,
            input: [],
          });
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

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

        // Create step for the different correlation ID too
        await createStep(storage, testRunId, {
          stepId: 'different-step',
          stepName: 'different-step',
          input: [],
        });

        // Create events with the target correlation ID
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(testRunId, {
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

        // step_created + step_started + step_completed = 3 events
        expect(result.data).toHaveLength(3);
        // First event is step_created from createStep
        expect(result.data[0].eventType).toBe('step_created');
        expect(result.data[0].correlationId).toBe(correlationId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[1].correlationId).toBe(correlationId);
        expect(result.data[2].eventId).toBe(event2.eventId);
        expect(result.data[2].correlationId).toBe(correlationId);
      });

      it('should list events across multiple runs with same correlation ID', async () => {
        const correlationId = 'hook-xyz789';

        // Create another run
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        // Create events in both runs with same correlation ID
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId,
          eventData: { token: `test-token-${correlationId}`, metadata: {} },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(run2.runId, {
          eventType: 'hook_received' as const,
          correlationId,
          eventData: { payload: { data: 'test' } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event3 } = await storage.events.create(testRunId, {
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
        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'existing-step',
          stepName: 'existing-step',
          input: [],
        });

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

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

        // Create multiple events
        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await storage.events.create(testRunId, {
          eventType: 'step_retrying' as const,
          correlationId,
          eventData: { error: 'retry error' },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        // Get first page (step_created + step_started = 2)
        const page1 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        // Get second page (step_retrying + step_started + step_completed = 3)
        const page2 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 3, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(3);
        expect(page2.hasMore).toBe(false);
      });

      it('should filter event data when resolveData is "none"', async () => {
        const correlationId = 'step-with-data';

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

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

        // step_created + step_completed = 2 events
        expect(result.data).toHaveLength(2);
        expect((result.data[0] as any).eventData).toBeUndefined();
        expect((result.data[1] as any).eventData).toBeUndefined();
        expect(result.data[0].correlationId).toBe(correlationId);
      });

      it('should return events in ascending order by default', async () => {
        const correlationId = 'step-ordering';

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create events with slight delays to ensure different timestamps
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        // step_created + step_started + step_completed = 3 events
        expect(result.data).toHaveLength(3);
        // Verify order: step_created, step_started, step_completed
        expect(result.data[0].eventType).toBe('step_created');
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[2].eventId).toBe(event2.eventId);
        expect(result.data[0].createdAt.getTime()).toBeLessThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support descending order', async () => {
        const correlationId = 'step-desc-order';

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId,
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { sortOrder: 'desc' },
        });

        // step_created + step_started + step_completed = 3 events
        expect(result.data).toHaveLength(3);
        // Verify order: step_completed, step_started, step_created (descending)
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[2].eventType).toBe('step_created');
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should handle hook lifecycle events', async () => {
        const hookId = 'hook_test123';

        // Create a typical hook lifecycle
        const { event: created } = await storage.events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: hookId,
          eventData: { token: `test-token-${hookId}`, metadata: {} },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: received1 } = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: received2 } = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: disposed } = await storage.events.create(testRunId, {
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
      const run = await createRun(storage, {
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

        const hook = await createHook(storage, testRunId, hookData);

        expect(hook.runId).toBe(testRunId);
        expect(hook.hookId).toBe('hook_123');
        expect(hook.token).toBe('my-hook-token');
        expect(hook.createdAt).toBeInstanceOf(Date);

        // Verify file was created
        const filePath = path.join(testDir, 'hooks', 'hook_123.json');
        const fileExists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);
      });

      it('should return hook_conflict event when creating a hook with a duplicate token', async () => {
        // Create first hook with a token
        const hookData = {
          hookId: 'hook_1',
          token: 'duplicate-test-token',
        };

        await createHook(storage, testRunId, hookData);

        // Try to create another hook with the same token - should return hook_conflict event
        const result = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token: 'duplicate-test-token' },
        });

        expect(result.event.eventType).toBe('hook_conflict');
        expect(result.event.correlationId).toBe('hook_2');
        expect((result.event as any).eventData.token).toBe(
          'duplicate-test-token'
        );
        expect(result.hook).toBeUndefined();
      });

      it('should allow multiple hooks with different tokens for the same run', async () => {
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });

        const hook2 = await createHook(storage, testRunId, {
          hookId: 'hook_2',
          token: 'token-2',
        });

        expect(hook1.token).toBe('token-1');
        expect(hook2.token).toBe('token-2');
      });

      it('should allow the same token only after disposing the previous hook', async () => {
        const token = 'reusable-token';

        // Create first hook
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token,
        });

        expect(hook1.token).toBe(token);

        // Try to create another hook with the same token - should return hook_conflict
        const conflictResult = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token },
        });

        expect(conflictResult.event.eventType).toBe('hook_conflict');
        expect(conflictResult.hook).toBeUndefined();

        // Dispose the first hook via hook_disposed event
        await disposeHook(storage, testRunId, 'hook_1');

        // Now we should be able to create a new hook with the same token
        const hook2 = await createHook(storage, testRunId, {
          hookId: 'hook_2',
          token,
        });

        expect(hook2.token).toBe(token);
        expect(hook2.hookId).toBe('hook_2');
      });

      it('should enforce token uniqueness across different runs within the same project', async () => {
        // Create a second run
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'another-workflow',
          input: [],
        });

        const token = 'shared-token-across-runs';

        // Create hook in first run
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token,
        });

        expect(hook1.token).toBe(token);

        // Try to create hook with same token in second run - should return hook_conflict
        const result = await storage.events.create(run2.runId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token },
        });

        expect(result.event.eventType).toBe('hook_conflict');
        expect((result.event as any).eventData.token).toBe(token);
        expect(result.hook).toBeUndefined();
      });
    });

    describe('get', () => {
      it('should retrieve an existing hook by hookId', async () => {
        const created = await createHook(storage, testRunId, {
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
        const created = await createHook(storage, testRunId, {
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
        const created = await createHook(storage, testRunId, {
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
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });
        await createHook(storage, testRunId, {
          hookId: 'hook_2',
          token: 'token-2',
        });
        await createHook(storage, testRunId, {
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
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });

        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));

        const hook2 = await createHook(storage, testRunId, {
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
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        await createHook(storage, testRunId, {
          hookId: 'hook_run1',
          token: 'token-run1',
        });
        const hook2 = await createHook(storage, run2.runId, {
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
          await createHook(storage, testRunId, {
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
        const hook1 = await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token: 'token-1',
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const hook2 = await createHook(storage, testRunId, {
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
        await createHook(storage, testRunId, {
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
  });

  describe('step terminal state validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('completed step', () => {
      it('should reject step_started on completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_terminal_1',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_1',
          'step_completed',
          {
            result: 'done',
          }
        );

        await expect(
          updateStep(storage, testRunId, 'step_terminal_1', 'step_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_completed on already completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_terminal_2',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_2',
          'step_completed',
          {
            result: 'done',
          }
        );

        await expect(
          updateStep(storage, testRunId, 'step_terminal_2', 'step_completed', {
            result: 'done again',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_terminal_3',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_3',
          'step_completed',
          {
            result: 'done',
          }
        );

        await expect(
          updateStep(storage, testRunId, 'step_terminal_3', 'step_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('failed step', () => {
      it('should reject step_started on failed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_failed_1',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(storage, testRunId, 'step_failed_1', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(storage, testRunId, 'step_failed_1', 'step_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_completed on failed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_failed_2',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(storage, testRunId, 'step_failed_2', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(storage, testRunId, 'step_failed_2', 'step_completed', {
            result: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on already failed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_failed_3',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(storage, testRunId, 'step_failed_3', 'step_failed', {
          error: 'Failed once',
        });

        await expect(
          updateStep(storage, testRunId, 'step_failed_3', 'step_failed', {
            error: 'Failed again',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_retrying on failed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_failed_retry',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          storage,
          testRunId,
          'step_failed_retry',
          'step_failed',
          {
            error: 'Failed permanently',
          }
        );

        await expect(
          updateStep(storage, testRunId, 'step_failed_retry', 'step_retrying', {
            error: 'Retry attempt',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('step_retrying validation', () => {
      it('should reject step_retrying on completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_completed_retry',
          stepName: 'test-step',
          input: [],
        });
        await updateStep(
          storage,
          testRunId,
          'step_completed_retry',
          'step_completed',
          {
            result: 'done',
          }
        );

        await expect(
          updateStep(
            storage,
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
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: 'done',
        });

        await expect(
          updateRun(storage, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on completed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: 'done',
        });

        await expect(
          updateRun(storage, run.runId, 'run_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on completed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: 'done',
        });

        await expect(
          storage.events.create(run.runId, { eventType: 'run_cancelled' })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('failed run', () => {
      it('should reject run_started on failed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(storage, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_completed on failed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(storage, run.runId, 'run_completed', {
            output: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on failed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          storage.events.create(run.runId, { eventType: 'run_cancelled' })
        ).rejects.toThrow(/terminal/i);
      });
    });

    describe('cancelled run', () => {
      it('should reject run_started on cancelled run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await storage.events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(storage, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_completed on cancelled run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await storage.events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(storage, run.runId, 'run_completed', {
            output: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on cancelled run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await storage.events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(storage, run.runId, 'run_failed', {
            error: 'Should not work',
          })
        ).rejects.toThrow(/terminal/i);
      });
    });
  });

  describe('allowed operations on terminal runs', () => {
    it('should allow step_completed on completed run for in-progress step', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create and start a step (making it in-progress)
      await createStep(storage, run.runId, {
        stepId: 'step_in_progress',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(storage, run.runId, 'step_in_progress', 'step_started');

      // Complete the run while step is still running
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      // Should succeed - completing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        storage,
        run.runId,
        'step_in_progress',
        'step_completed',
        { result: 'step done' }
      );
      expect(result.status).toBe('completed');
    });

    it('should allow step_failed on completed run for in-progress step', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create and start a step
      await createStep(storage, run.runId, {
        stepId: 'step_in_progress_fail',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(
        storage,
        run.runId,
        'step_in_progress_fail',
        'step_started'
      );

      // Complete the run
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      // Should succeed - failing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        storage,
        run.runId,
        'step_in_progress_fail',
        'step_failed',
        { error: 'step failed' }
      );
      expect(result.status).toBe('failed');
    });

    it('should auto-delete hooks when run completes (world-local specific behavior)', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a hook
      await createHook(storage, run.runId, {
        hookId: 'hook_auto_delete',
        token: 'test-token-auto-delete',
      });

      // Verify hook exists before completion
      const hookBefore = await storage.hooks.get('hook_auto_delete');
      expect(hookBefore).toBeDefined();

      // Complete the run - this auto-deletes hooks in world-local
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      // Hook should be auto-deleted
      await expect(storage.hooks.get('hook_auto_delete')).rejects.toThrow(
        /not found/i
      );
    });
  });

  describe('disallowed operations on terminal runs', () => {
    it('should reject step_created on completed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started on completed run for pending step', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a step but don't start it
      await createStep(storage, run.runId, {
        stepId: 'pending_step',
        stepName: 'test-step',
        input: [],
      });

      // Complete the run
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      // Should reject - cannot start a pending step on a terminal run
      await expect(
        updateStep(storage, run.runId, 'pending_step', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on completed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(storage, run.runId, 'run_completed', { output: 'done' });

      await expect(
        createHook(storage, run.runId, {
          hookId: 'new_hook',
          token: 'new-token',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on failed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_failed',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on cancelled run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_cancelled',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on failed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createHook(storage, run.runId, {
          hookId: 'new_hook_failed',
          token: 'new-token-failed',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on cancelled run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createHook(storage, run.runId, {
          hookId: 'new_hook_cancelled',
          token: 'new-token-cancelled',
        })
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('idempotent operations', () => {
    it('should allow run_cancelled on already cancelled run (idempotent)', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      // Should succeed - idempotent operation
      const result = await storage.events.create(run.runId, {
        eventType: 'run_cancelled',
      });
      expect(result.run?.status).toBe('cancelled');
    });
  });

  describe('step_retrying event handling', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should set step status to pending and record error', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_retry_1',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(storage, testRunId, 'step_retry_1', 'step_started');

      const result = await storage.events.create(testRunId, {
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
      await createStep(storage, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: [],
      });

      // First attempt
      const started1 = await updateStep(
        storage,
        testRunId,
        'step_retry_2',
        'step_started'
      );
      expect(started1.attempt).toBe(1);

      // Retry
      await storage.events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_2',
        eventData: { error: 'Temporary failure' },
      });

      // Second attempt
      const started2 = await updateStep(
        storage,
        testRunId,
        'step_retry_2',
        'step_started'
      );
      expect(started2.attempt).toBe(2);
    });

    it('should reject step_retrying on completed step', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_retry_completed',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(
        storage,
        testRunId,
        'step_retry_completed',
        'step_completed',
        {
          result: 'done',
        }
      );

      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step_retry_completed',
          eventData: { error: 'Should not work' },
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_retrying on failed step', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_retry_failed',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(storage, testRunId, 'step_retry_failed', 'step_failed', {
        error: 'Permanent failure',
      });

      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step_retry_failed',
          eventData: { error: 'Should not work' },
        })
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('run cancellation with in-flight entities', () => {
    it('should allow in-progress step to complete after run cancelled', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create and start a step
      await createStep(storage, run.runId, {
        stepId: 'step_in_flight',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(storage, run.runId, 'step_in_flight', 'step_started');

      // Cancel the run
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      // Should succeed - completing an in-progress step is allowed
      const result = await updateStep(
        storage,
        run.runId,
        'step_in_flight',
        'step_completed',
        { result: 'done' }
      );
      expect(result.status).toBe('completed');
    });

    it('should reject step_created after run cancelled', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_after_cancel',
          stepName: 'test-step',
          input: [],
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started for pending step after run cancelled', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a step but don't start it
      await createStep(storage, run.runId, {
        stepId: 'pending_after_cancel',
        stepName: 'test-step',
        input: [],
      });

      // Cancel the run
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      // Should reject - cannot start a pending step on a cancelled run
      await expect(
        updateStep(storage, run.runId, 'pending_after_cancel', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });
  });

  describe('event ordering validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should reject step_completed before step_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'nonexistent_step',
          eventData: { result: 'done' },
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_started before step_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'nonexistent_step_started',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_failed before step_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'nonexistent_step_failed',
          eventData: { error: 'Failed' },
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should allow step_completed without step_started (instant completion)', async () => {
      await createStep(storage, testRunId, {
        stepId: 'instant_complete',
        stepName: 'test-step',
        input: [],
      });

      // Should succeed - instant completion without starting
      const result = await updateStep(
        storage,
        testRunId,
        'instant_complete',
        'step_completed',
        { result: 'instant' }
      );
      expect(result.status).toBe('completed');
    });

    it('should reject hook_disposed before hook_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'nonexistent_hook',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_received before hook_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'nonexistent_hook_received',
          eventData: { payload: {} },
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('legacy/backwards compatibility', () => {
    // Helper to create a legacy run directly on disk (bypassing events.create)
    async function createLegacyRun(
      runId: string,
      specVersion: number | undefined
    ) {
      const runsDir = path.join(testDir, 'runs');
      await fs.mkdir(runsDir, { recursive: true });
      const run = {
        runId,
        deploymentId: 'legacy-deployment',
        workflowName: 'legacy-workflow',
        specVersion,
        status: 'running',
        input: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await fs.writeFile(
        path.join(runsDir, `${runId}.json`),
        JSON.stringify(run, null, 2)
      );
      return run;
    }

    describe('legacy runs (specVersion < 2 or undefined)', () => {
      it('should handle run_cancelled on legacy run with specVersion=1', async () => {
        const runId = 'wrun_legacy_v1';
        await createLegacyRun(runId, 1);

        const result = await storage.events.create(runId, {
          eventType: 'run_cancelled',
        });

        // Legacy behavior: run is updated but event is not stored
        expect(result.run?.status).toBe('cancelled');
        expect(result.event).toBeUndefined();
      });

      it('should handle run_cancelled on legacy run with specVersion=undefined', async () => {
        const runId = 'wrun_legacy_undefined';
        await createLegacyRun(runId, undefined);

        const result = await storage.events.create(runId, {
          eventType: 'run_cancelled',
        });

        // Legacy behavior: run is updated but event is not stored
        expect(result.run?.status).toBe('cancelled');
        expect(result.event).toBeUndefined();
      });

      it('should handle wait_completed on legacy run', async () => {
        const runId = 'wrun_legacy_wait';
        await createLegacyRun(runId, 1);

        const result = await storage.events.create(runId, {
          eventType: 'wait_completed',
          correlationId: 'wait_123',
          eventData: { result: 'waited' },
        } as any);

        // Legacy behavior: event is stored but no entity mutation
        expect(result.event).toBeDefined();
        expect(result.event?.eventType).toBe('wait_completed');
        expect(result.run).toBeUndefined();
      });

      it('should reject unsupported events on legacy runs', async () => {
        const runId = 'wrun_legacy_unsupported';
        await createLegacyRun(runId, 1);

        // run_started is not supported for legacy runs
        await expect(
          storage.events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/not supported for legacy runs/i);

        // run_completed is not supported for legacy runs
        await expect(
          storage.events.create(runId, {
            eventType: 'run_completed',
            eventData: { output: 'done' },
          })
        ).rejects.toThrow(/not supported for legacy runs/i);

        // run_failed is not supported for legacy runs
        await expect(
          storage.events.create(runId, {
            eventType: 'run_failed',
            eventData: { error: 'failed' },
          })
        ).rejects.toThrow(/not supported for legacy runs/i);
      });

      it('should delete hooks when legacy run is cancelled', async () => {
        const runId = 'wrun_legacy_hooks';
        await createLegacyRun(runId, 1);

        // Create a hook for this run (hooks can be created on legacy runs)
        const hooksDir = path.join(testDir, 'hooks');
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.writeFile(
          path.join(hooksDir, 'hook_legacy.json'),
          JSON.stringify({
            hookId: 'hook_legacy',
            runId,
            token: 'legacy-token',
            ownerId: 'test-owner',
            projectId: 'test-project',
            environment: 'test',
            createdAt: new Date(),
          })
        );

        // Verify hook exists
        const hookBefore = await storage.hooks.get('hook_legacy');
        expect(hookBefore).toBeDefined();

        // Cancel the legacy run
        await storage.events.create(runId, { eventType: 'run_cancelled' });

        // Hook should be deleted
        await expect(storage.hooks.get('hook_legacy')).rejects.toThrow(
          /not found/i
        );
      });
    });

    describe('newer runs (specVersion > current)', () => {
      it('should reject events on runs with newer specVersion', async () => {
        const runId = 'wrun_future';
        // Create a run with a future spec version (higher than current)
        await createLegacyRun(runId, 999);

        await expect(
          storage.events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/requires spec version 999/i);
      });
    });

    describe('current version runs', () => {
      it('should process events normally for current specVersion runs', async () => {
        // Create run via events.create (gets current specVersion)
        const run = await createRun(storage, {
          deploymentId: 'current-deployment',
          workflowName: 'current-workflow',
          input: [],
        });

        // Should work normally
        const result = await storage.events.create(run.runId, {
          eventType: 'run_started',
        });

        expect(result.run?.status).toBe('running');
        expect(result.event?.eventType).toBe('run_started');
      });
    });
  });
});
