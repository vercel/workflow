import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import type { Event, Storage } from '@workflow/world';
import { SPEC_VERSION_CURRENT, stripEventDataRefs } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJSON } from './fs.js';
import { hashToken, hookDisposeLockPath } from './storage/helpers.js';
import { createStorage } from './storage.js';
import {
  completeWait,
  createHook,
  createRun,
  createStep,
  createWait,
  disposeHook,
  updateRun,
  updateStep,
} from './test-helpers.js';

describe('stripEventDataRefs', () => {
  const baseEvent = {
    runId: 'wrun_test',
    eventId: 'evnt_test',
    createdAt: new Date(),
    specVersion: 2,
  };

  it('should strip input ref from step_created, keep stepName', () => {
    const event = {
      ...baseEvent,
      eventType: 'step_created' as const,
      correlationId: 'step_1',
      eventData: { stepName: 'my-step', input: new Uint8Array([1, 2, 3]) },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result.eventData).toEqual({ stepName: 'my-step' });
    expect(result.eventData).not.toHaveProperty('input');
  });

  it('should strip input ref from run_created, keep workflowName and deploymentId', () => {
    const event = {
      ...baseEvent,
      eventType: 'run_created' as const,
      eventData: {
        deploymentId: 'dpl_123',
        workflowName: 'my-workflow',
        input: new Uint8Array([1, 2, 3]),
      },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result.eventData).toEqual({
      deploymentId: 'dpl_123',
      workflowName: 'my-workflow',
    });
    expect(result.eventData).not.toHaveProperty('input');
  });

  it('should strip result ref from step_completed entirely', () => {
    const event = {
      ...baseEvent,
      eventType: 'step_completed' as const,
      correlationId: 'step_1',
      eventData: { result: new Uint8Array([4, 5]) },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result.eventData).toBeUndefined();
  });

  it('should strip error from run_failed, keep errorCode', () => {
    const event = {
      ...baseEvent,
      eventType: 'run_failed' as const,
      eventData: { error: 'something broke', errorCode: 'TIMEOUT' },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result.eventData).toEqual({ errorCode: 'TIMEOUT' });
    expect(result.eventData).not.toHaveProperty('error');
  });

  it('should strip error from step_failed, leaving no eventData when it was the only field', () => {
    // step_failed eventData only holds the (opaque, large) `error` payload.
    // When resolveData is 'none' the error is stripped; since nothing else
    // remains, eventData is dropped from the event entirely.
    const event = {
      ...baseEvent,
      eventType: 'step_failed' as const,
      correlationId: 'step_1',
      eventData: { error: new Uint8Array([1, 2, 3]) },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result).not.toHaveProperty('eventData');
  });

  it('should not strip anything when resolveData is "all"', () => {
    const event = {
      ...baseEvent,
      eventType: 'step_created' as const,
      correlationId: 'step_1',
      eventData: { stepName: 'my-step', input: new Uint8Array([1, 2, 3]) },
    } as Event;

    const result = stripEventDataRefs(event, 'all') as any;
    expect(result.eventData.stepName).toBe('my-step');
    expect(result.eventData.input).toBeDefined();
  });

  it('should pass through events with no ref fields (e.g. run_started)', () => {
    const event = {
      ...baseEvent,
      eventType: 'run_started' as const,
    } as Event;

    const result = stripEventDataRefs(event, 'none');
    expect(result).toEqual(event);
  });

  it('should strip metadata from hook_created, keep token', () => {
    const event = {
      ...baseEvent,
      eventType: 'hook_created' as const,
      correlationId: 'hook_1',
      eventData: { token: 'tok_abc', metadata: { some: 'data' } },
    } as Event;

    const result = stripEventDataRefs(event, 'none') as any;
    expect(result.eventData).toEqual({ token: 'tok_abc' });
    expect(result.eventData).not.toHaveProperty('metadata');
  });
});

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
    vi.restoreAllMocks();
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
          input: new Uint8Array([1, 2]),
        };

        const run = await createRun(storage, runData);

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
          input: new Uint8Array(),
        };

        const run = await createRun(storage, runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual(new Uint8Array());
      });

      it('should seed initial attributes from run_created', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'attributed-workflow',
          input: new Uint8Array(),
          attributes: { tenant: 't1', phase: 'created' },
        });

        expect(run.attributes).toEqual({ tenant: 't1', phase: 'created' });
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
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

    describe('getMany', () => {
      it('preserves input order, deduplicates reads, and returns null for missing runs', async () => {
        const first = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'first-workflow',
          input: new Uint8Array([1]),
        });
        const second = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'second-workflow',
          input: new Uint8Array([2]),
        });

        const results = await storage.runs.getMany(
          [first.runId, 'wrun_missing', second.runId, first.runId],
          { resolveData: 'none' }
        );

        expect(results.map((run) => run?.runId ?? null)).toEqual([
          first.runId,
          null,
          second.runId,
          first.runId,
        ]);
        expect(results[0]?.input).toBeUndefined();
        expect(results[2]?.output).toBeUndefined();
      });
    });

    describe('update via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });

        const updated = await updateRun(
          storage,
          created.runId,
          'run_completed',
          {
            output: new Uint8Array([1]),
          }
        );

        expect(updated.status).toBe('completed');
        expect(updated.output).toBeInstanceOf(Uint8Array);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update run status to failed via run_failed event', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });

        // The `error` field is now opaque SerializedData (Uint8Array) produced
        // by dehydrateRunError. The storage layer persists it verbatim; the
        // original thrown value is reconstructed by hydrateRunError at read
        // time on the consumer side.
        const serializedError = new Uint8Array([1, 2, 3]);
        const updated = await updateRun(storage, created.runId, 'run_failed', {
          error: serializedError,
        });

        expect(updated.status).toBe('failed');
        expect(updated.error).toEqual(serializedError);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should reject run_failed on non-existent run', async () => {
        await expect(
          updateRun(storage, 'wrun_nonexistent', 'run_failed', {
            error: 'Something went wrong',
          })
        ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
      });

      it('should materialize attr_set events and preserve event history', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
          attributes: { stale: 'remove' },
        });

        const result = await storage.events.create(created.runId, {
          eventType: 'attr_set',
          specVersion: 4,
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
        expect((await storage.runs.get(created.runId)).attributes).toEqual({
          phase: 'ready',
        });
      });

      it('should allow reserved native attributes only with the opt-in flag', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });

        await expect(
          storage.events.create(created.runId, {
            eventType: 'attr_set',
            specVersion: 4,
            eventData: {
              changes: [{ key: '$system', value: 'nope' }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/reserved prefix/);

        const result = await storage.events.create(created.runId, {
          eventType: 'attr_set',
          specVersion: 4,
          eventData: {
            changes: [{ key: '$system', value: 'ok' }],
            writer: { type: 'workflow' },
            allowReservedAttributes: true,
          },
        });
        expect(result.run?.attributes).toEqual({ $system: 'ok' });
      });

      it('should enforce the per-run cap against existing attributes', async () => {
        const initial: Record<string, string> = {};
        for (let i = 0; i < 63; i++) initial[`a${i}`] = 'v';
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
          attributes: initial,
        });

        // 64th attribute fits exactly at the cap.
        const atCap = await storage.events.create(created.runId, {
          eventType: 'attr_set',
          specVersion: 4,
          eventData: {
            changes: [{ key: 'a63', value: 'v' }],
            writer: { type: 'workflow' },
          },
        });
        expect(Object.keys(atCap.run?.attributes ?? {})).toHaveLength(64);

        // A 65th attribute exceeds the cap with a clear error.
        await expect(
          storage.events.create(created.runId, {
            eventType: 'attr_set',
            specVersion: 4,
            eventData: {
              changes: [{ key: 'a64', value: 'v' }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/exceed limit 64/);

        // Upserting an existing key at the cap is a zero-net change.
        const upserted = await storage.events.create(created.runId, {
          eventType: 'attr_set',
          specVersion: 4,
          eventData: {
            changes: [{ key: 'a0', value: 'updated' }],
            writer: { type: 'step', stepId: 'step_1', attempt: 1 },
          },
        });
        expect(upserted.run?.attributes?.a0).toBe('updated');

        // Removing a key frees room for a new one in the same batch.
        const swapped = await storage.events.create(created.runId, {
          eventType: 'attr_set',
          specVersion: 4,
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

      it('should reject oversized attribute values on attr_set', async () => {
        const created = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await expect(
          storage.events.create(created.runId, {
            eventType: 'attr_set',
            specVersion: 4,
            eventData: {
              changes: [{ key: 'note', value: 'v'.repeat(257) }],
              writer: { type: 'workflow' },
            },
          })
        ).rejects.toThrow(/byte length 257 exceeds limit 256/);
      });

      it('should reject invalid initial attributes on run_created', async () => {
        const overCap: Record<string, string> = {};
        for (let i = 0; i <= 64; i++) overCap[`a${i}`] = 'v';
        await expect(
          createRun(storage, {
            deploymentId: 'deployment-123',
            workflowName: 'test-workflow',
            input: new Uint8Array(),
            attributes: overCap,
          })
        ).rejects.toThrow(/exceed limit 64/);

        await expect(
          createRun(storage, {
            deploymentId: 'deployment-123',
            workflowName: 'test-workflow',
            input: new Uint8Array(),
            attributes: { $reserved: 'nope' },
          })
        ).rejects.toThrow(/reserved prefix/);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun(storage, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: new Uint8Array(),
        });

        // Small delay to ensure different timestamps in ULIDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        const run2 = await createRun(storage, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: new Uint8Array(),
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
            input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step_123',
          stepName: 'test-step',
          input: new Uint8Array([1, 2]),
        };

        const step = await createStep(storage, testRunId, stepData);

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step_123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(new Uint8Array([1, 2]));
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
          input: new Uint8Array([1]),
        });

        const retrieved = await storage.steps.get(testRunId, 'step_123');

        expect(retrieved).toEqual(created);
      });

      it('should retrieve a step with runId and stepId', async () => {
        const created = await createStep(storage, testRunId, {
          stepId: 'unique_step_123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        const retrieved = await storage.steps.get(testRunId, 'unique_step_123');

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
          input: new Uint8Array([1]),
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
          input: new Uint8Array([1]),
        });

        const updated = await updateStep(
          storage,
          testRunId,
          'step_123',
          'step_completed',
          { result: new Uint8Array([1]) }
        );

        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual(new Uint8Array([1]));
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update step status to failed via step_failed event', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_123',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        });

        // The `error` field is now opaque SerializedData (Uint8Array) produced
        // by dehydrateStepError. The storage layer persists it verbatim.
        const serializedError = new Uint8Array([1, 2, 3]);
        const updated = await updateStep(
          storage,
          testRunId,
          'step_123',
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
        const result = await storage.events.create(testRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'lazy_step_1',
          eventData: {
            stepName: 'lazy-step',
            input: new Uint8Array([7, 8, 9]),
          },
        });

        // Returns a running step at attempt 1, just as a normal
        // step_created → step_started pair would.
        expect(result.step?.stepId).toBe('lazy_step_1');
        expect(result.step?.stepName).toBe('lazy-step');
        expect(result.step?.status).toBe('running');
        expect(result.step?.attempt).toBe(1);
        expect(result.step?.input).toEqual(new Uint8Array([7, 8, 9]));
        // The world reports that THIS call created the step (ownership signal).
        expect(result.stepCreated).toBe(true);

        // The step entity is persisted and readable.
        const persisted = await storage.steps.get(testRunId, 'lazy_step_1');
        expect(persisted.status).toBe('running');
        expect(persisted.input).toEqual(new Uint8Array([7, 8, 9]));
      });

      it('writes a synthetic step_created event so replay observes it', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'lazy_step_2',
          eventData: {
            stepName: 'lazy-step',
            input: new Uint8Array([1]),
          },
        });

        const events = await storage.events.listByCorrelationId({
          correlationId: 'lazy_step_2',
        });
        const types = events.data.map((e) => e.eventType);
        // Both a step_created (synthetic) and a step_started must be present:
        // the client replay consumer flips hasCreatedEvent only on step_created.
        expect(types).toContain('step_created');
        expect(types).toContain('step_started');

        // The synthetic step_created carries the input; the step_started row
        // carries stepName but not input (it lives on step_created).
        const created = events.data.find((e) => e.eventType === 'step_created');
        expect(
          (created?.eventData as { input?: unknown } | undefined)?.input
        ).toBeDefined();
        const started = events.data.find((e) => e.eventType === 'step_started');
        expect(
          (started?.eventData as { input?: unknown } | undefined)?.input
        ).toBeUndefined();
      });

      it('still rejects a bare step_started (no input) on a missing step', async () => {
        await expect(
          storage.events.create(testRunId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: 'never_created',
            eventData: { stepName: 'legacy-step' },
          })
        ).rejects.toThrow('not found');
      });

      it('rejects a lazy step_started on a terminal run', async () => {
        await updateRun(storage, testRunId, 'run_started');
        await updateRun(storage, testRunId, 'run_completed', {
          output: new Uint8Array([1]),
        });

        await expect(
          storage.events.create(testRunId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: 'lazy_on_terminal',
            eventData: {
              stepName: 'lazy-step',
              input: new Uint8Array([1]),
            },
          })
        ).rejects.toThrow('terminal state');
      });

      it('rejects a second lazy step_started for an existing step (concurrent loser)', async () => {
        // First lazy call creates + starts (attempt 1) and reports ownership.
        const first = await storage.events.create(testRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'lazy_step_3',
          eventData: {
            stepName: 'lazy-step',
            input: new Uint8Array([1]),
          },
        });
        expect(first.step?.attempt).toBe(1);
        expect(first.stepCreated).toBe(true);

        // A lazy step_started is only ever sent for a brand-new step (the
        // owned-inline path defers step_created only for steps with no prior
        // step_created event). So if the step already exists when a lazy
        // step_started arrives, this caller LOST the create race and must not
        // run the body. The world surfaces EntityConflictError, which
        // executeStep maps to `skipped`. This is the exactly-one-owner gate.
        await expect(
          storage.events.create(testRunId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: 'lazy_step_3',
            eventData: {
              stepName: 'lazy-step',
              input: new Uint8Array([1]),
            },
          })
        ).rejects.toThrow('already created');
      });

      it('crash recovery re-starts via a non-lazy step_started on the existing step', async () => {
        // Owner creates + starts the step lazily (attempt 1), then "crashes"
        // before completing. On recovery the step already exists with its
        // step_created event, so the step is re-queued and re-run via a
        // NON-lazy step_started (no input). That path re-starts the running
        // step, bumping the attempt counter — at-least-once execution.
        await storage.events.create(testRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'lazy_step_4',
          eventData: {
            stepName: 'lazy-step',
            input: new Uint8Array([1]),
          },
        });

        const rerun = await updateStep(
          storage,
          testRunId,
          'lazy_step_4',
          'step_started',
          {}
        );
        expect(rerun.status).toBe('running');
        expect(rerun.attempt).toBe(2);
      });

      it('a lazy step_started followed by step_failed marks the step failed', async () => {
        // Regression guard for the unregistered-step path on the lazy inline
        // route. When a step's function isn't registered, executeStep must
        // first send the lazy step_started (to materialize the step the
        // suspension handler deferred) and only THEN write step_failed.
        // Writing step_failed against a never-created step would hit the
        // "step must exist" ordering guard and wedge the run. This asserts the
        // create-then-fail sequence the runtime relies on.
        await storage.events.create(testRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'lazy_step_fail',
          eventData: {
            stepName: 'ghost-step',
            input: new Uint8Array([1]),
          },
        });

        const failed = await updateStep(
          storage,
          testRunId,
          'lazy_step_fail',
          'step_failed',
          { error: new Uint8Array([2, 3]) }
        );
        expect(failed.status).toBe('failed');
        expect(failed.attempt).toBe(1);

        const persisted = await storage.steps.get(testRunId, 'lazy_step_fail');
        expect(persisted.status).toBe('failed');
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await createStep(storage, testRunId, {
          stepId: 'step_1',
          stepName: 'first-step',
          input: new Uint8Array(),
        });
        const step2 = await createStep(storage, testRunId, {
          stepId: 'step_2',
          stepName: 'second-step',
          input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
            input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // Create step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
          input: new Uint8Array(),
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

      it('should handle run completed events', async () => {
        const eventData = {
          eventType: 'run_completed' as const,
          eventData: { output: new Uint8Array([2]) },
        };

        const { event } = await storage.events.create(testRunId, eventData);

        expect(event.eventType).toBe('run_completed');
        expect(event.correlationId).toBeUndefined();
      });
    });

    // Inline-delta optimization: a step-terminal write carrying
    // `sinceCursor` returns the event-log delta since that cursor so the
    // inline runtime loop can skip an incremental events.list round-trip.
    describe('inline delta (sinceCursor)', () => {
      // Capture the cursor as of the latest event in the run — what the
      // runtime would hold before it begins writing the next step's events.
      async function currentCursor(): Promise<string> {
        const listed = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });
        const cursor = listed.cursor;
        if (!cursor) throw new Error('expected a cursor');
        return cursor;
      }

      it('returns the events written since the cursor on step_completed, matching events.list', async () => {
        await updateRun(storage, testRunId, 'run_started');
        const sinceCursor = await currentCursor();

        // A sequential step: create -> started -> completed. The terminal
        // write carries sinceCursor and should return all three.
        await createStep(storage, testRunId, {
          stepId: 'corr_seq',
          stepName: 'seq-step',
          input: new Uint8Array(),
        });
        await updateStep(storage, testRunId, 'corr_seq', 'step_started', {
          stepName: 'seq-step',
        });
        const result = await storage.events.create(
          testRunId,
          {
            eventType: 'step_completed' as const,
            correlationId: 'corr_seq',
            eventData: { stepName: 'seq-step', result: new Uint8Array([1]) },
          },
          { sinceCursor }
        );

        // The delta is exactly what a fresh events.list(sinceCursor) returns.
        const fetched = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc', cursor: sinceCursor },
        });

        expect(result.events).toBeDefined();
        expect(result.events?.map((e) => e.eventType)).toEqual([
          'step_created',
          'step_started',
          'step_completed',
        ]);
        expect(result.events?.map((e) => e.eventId)).toEqual(
          fetched.data.map((e) => e.eventId)
        );
        expect(result.cursor).toBe(fetched.cursor);
        expect(result.hasMore).toBe(fetched.hasMore);
      });

      it('captures in-band events (hook_received) interleaved before the terminal write', async () => {
        await updateRun(storage, testRunId, 'run_started');
        // An open hook exists; an external party delivers a payload while the
        // step is running. The delta MUST include the hook_received so the
        // inline loop does not drop it and skew from the server log.
        await createHook(storage, testRunId, {
          hookId: 'corr_hook',
          token: 'tok_inband',
        });
        const sinceCursor = await currentCursor();

        await createStep(storage, testRunId, {
          stepId: 'corr_seq2',
          stepName: 'seq-step',
          input: new Uint8Array(),
        });
        await updateStep(storage, testRunId, 'corr_seq2', 'step_started', {
          stepName: 'seq-step',
        });
        // In-band hook delivery lands between step_started and step_completed.
        await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: 'corr_hook',
          eventData: { token: 'tok_inband', payload: new Uint8Array([9]) },
        });
        const result = await storage.events.create(
          testRunId,
          {
            eventType: 'step_completed' as const,
            correlationId: 'corr_seq2',
            eventData: { stepName: 'seq-step', result: new Uint8Array([1]) },
          },
          { sinceCursor }
        );

        const fetched = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc', cursor: sinceCursor },
        });

        expect(result.events?.map((e) => e.eventType)).toContain(
          'hook_received'
        );
        expect(result.events?.map((e) => e.eventId)).toEqual(
          fetched.data.map((e) => e.eventId)
        );
        expect(result.cursor).toBe(fetched.cursor);
      });

      it('truncates the delta and surfaces hasMore=true when it exceeds one page, matching events.list', async () => {
        // Safety property the runtime relies on (see the limit/hasMore/fallback
        // contract at events-storage.ts and the consume gate in runtime.ts):
        // the inline-delta query uses paginatedFileSystemQuery's default page
        // size, so a delta larger than one page is truncated and MUST report
        // hasMore=true. The runtime refuses to consume a truncated delta and
        // falls back to the exhaustive events.list loop, so a partial page can
        // never be mistaken for the complete delta.
        await updateRun(storage, testRunId, 'run_started');

        await createHook(storage, testRunId, {
          hookId: 'corr_delta_page_hook',
          token: 'tok_delta_page_hook',
        });
        const sinceCursor = await currentCursor();

        // A burst of in-band hook deliveries lands while the step runs. One
        // hook is enough here; the assertion is about delta pagination, not
        // creating many distinct hook tokens.
        const DELTA_FILLER_EVENT_COUNT = 21; // > default page limit (20)
        for (let i = 0; i < DELTA_FILLER_EVENT_COUNT; i++) {
          await storage.events.create(testRunId, {
            eventType: 'hook_received' as const,
            correlationId: 'corr_delta_page_hook',
            eventData: {
              token: 'tok_delta_page_hook',
              payload: new Uint8Array([i]),
            },
          });
        }
        await createStep(storage, testRunId, {
          stepId: 'corr_seq_big',
          stepName: 'seq-step',
          input: new Uint8Array(),
        });
        await updateStep(storage, testRunId, 'corr_seq_big', 'step_started', {
          stepName: 'seq-step',
        });
        const result = await storage.events.create(
          testRunId,
          {
            eventType: 'step_completed' as const,
            correlationId: 'corr_seq_big',
            eventData: { stepName: 'seq-step', result: new Uint8Array([1]) },
          },
          { sinceCursor }
        );

        // The delta is truncated: it carries exactly the first page and signals
        // that more remains — byte-identical to events.list(sinceCursor).
        const firstPage = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc', cursor: sinceCursor },
        });

        expect(result.hasMore).toBe(true);
        expect(firstPage.hasMore).toBe(true);
        expect(result.events?.length).toBeLessThan(
          DELTA_FILLER_EVENT_COUNT + 3
        );
        expect(result.events?.map((e) => e.eventId)).toEqual(
          firstPage.data.map((e) => e.eventId)
        );
        expect(result.cursor).toBe(firstPage.cursor);
      });

      it('does not return a delta when sinceCursor is omitted', async () => {
        await updateRun(storage, testRunId, 'run_started');
        await createStep(storage, testRunId, {
          stepId: 'corr_seq3',
          stepName: 'seq-step',
          input: new Uint8Array(),
        });
        await updateStep(storage, testRunId, 'corr_seq3', 'step_started', {
          stepName: 'seq-step',
        });
        const result = await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId: 'corr_seq3',
          eventData: { stepName: 'seq-step', result: new Uint8Array([1]) },
        });
        expect(result.events).toBeUndefined();
        expect(result.cursor).toBeUndefined();
      });

      it('does not return a delta for non-terminal step events', async () => {
        await updateRun(storage, testRunId, 'run_started');
        const sinceCursor = await currentCursor();
        await createStep(storage, testRunId, {
          stepId: 'corr_seq4',
          stepName: 'seq-step',
          input: new Uint8Array(),
        });
        // step_started carries sinceCursor but is not a loop boundary, so the
        // World should not compute a delta for it.
        const result = await storage.events.create(
          testRunId,
          {
            eventType: 'step_started' as const,
            correlationId: 'corr_seq4',
            eventData: { stepName: 'seq-step' },
          },
          { sinceCursor }
        );
        expect(result.events).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        // Note: testRunId was created via createRun which creates a run_created event
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'run_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_step_1',
          stepName: 'test-step',
          input: new Uint8Array(),
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

        // 4 events: run_created (from createRun), run_started, step_created, step_started
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
          eventType: 'run_started' as const,
        });

        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 2));

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: 'corr_step_1',
          stepName: 'test-step',
          input: new Uint8Array(),
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

        // 4 events: run_created (from createRun), run_started, step_created, step_started
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
            input: new Uint8Array(),
          });
          await storage.events.create(testRunId, {
            eventType: 'step_completed' as const,
            correlationId: `corr_${i}`,
            eventData: { result: new Uint8Array([i]) },
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
          input: new Uint8Array(),
        });

        // Create step for the different correlation ID too
        await createStep(storage, testRunId, {
          stepId: 'different-step',
          stepName: 'different-step',
          input: new Uint8Array(),
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
          eventData: { result: new Uint8Array([1]) },
        });

        // Create events with different correlation IDs (should be filtered out)
        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'different-step',
        });
        await storage.events.create(testRunId, {
          eventType: 'run_completed' as const,
          eventData: { output: new Uint8Array([2]) },
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
          input: new Uint8Array(),
        });

        // Create events in both runs with same correlation ID
        const { event: event1 } = await storage.events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId,
          eventData: {
            token: `test-token-${correlationId}`,
            metadata: undefined,
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: event2 } = await storage.events.create(run2.runId, {
          eventType: 'hook_received' as const,
          correlationId,
          eventData: { payload: new Uint8Array([1, 2, 3]) },
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
          input: new Uint8Array(),
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
          input: new Uint8Array(),
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
          eventData: { result: new Uint8Array([1]) },
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
          input: new Uint8Array(),
        });

        await storage.events.create(testRunId, {
          eventType: 'step_completed' as const,
          correlationId,
          eventData: { result: new Uint8Array([1]) },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
          resolveData: 'none',
        });

        // step_created + step_completed = 2 events
        expect(result.data).toHaveLength(2);
        // step_created: ref field 'input' stripped, metadata like stepName preserved
        expect((result.data[0] as any).eventData).toEqual({
          stepName: 'test-step',
        });
        expect((result.data[0] as any).eventData).not.toHaveProperty('input');
        // step_completed: only ref field 'result' exists, so eventData is removed entirely
        expect((result.data[1] as any).eventData).toBeUndefined();
        expect(result.data[0].correlationId).toBe(correlationId);
      });

      it('should return events in ascending order by default', async () => {
        const correlationId = 'step-ordering';

        // Create the step first (required for step events)
        await createStep(storage, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: new Uint8Array(),
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
          eventData: { result: new Uint8Array([1]) },
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
          input: new Uint8Array(),
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
          eventData: { result: new Uint8Array([1]) },
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
          eventData: { token: `test-token-${hookId}`, metadata: undefined },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: received1 } = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: new Uint8Array([1]) },
        });

        await new Promise((resolve) => setTimeout(resolve, 2));

        const { event: received2 } = await storage.events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: new Uint8Array([2]) },
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

    it('reuses locally appended events without exposing cached instances', async () => {
      const created = await storage.events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'deployment-cache',
          workflowName: 'cached-event-workflow',
          input: new Uint8Array([1]),
        },
      });
      const runId = created.event.runId;
      (created.event as any).eventData.input[0] = 9;
      const readFileSpy = vi.spyOn(fs, 'readFile');

      const first = await storage.events.list({ runId });
      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads).toHaveLength(0);
      expect((first.data[0] as any).eventData.input).toEqual(
        new Uint8Array([1])
      );

      (first.data[0] as { eventType: string }).eventType = 'run_failed';
      const second = await storage.events.list({ runId });
      expect(second.data[0]?.eventType).toBe('run_created');
    });

    it('reuses sequential-step events with a relative data directory', async () => {
      const relativeStorage = createStorage(
        path.relative(process.cwd(), testDir)
      );
      const run = await createRun(relativeStorage, {
        deploymentId: 'deployment-relative-cache',
        workflowName: 'relative-cache-workflow',
        input: new Uint8Array([1]),
      });
      await updateRun(relativeStorage, run.runId, 'run_started');
      const readFileSpy = vi.spyOn(fs, 'readFile');

      for (let i = 0; i < 5; i++) {
        const stepId = `relative_step_${i}`;
        await createStep(relativeStorage, run.runId, {
          stepId,
          stepName: `step-${i}`,
          input: new Uint8Array([i]),
        });
        await updateStep(relativeStorage, run.runId, stepId, 'step_started');
        await updateStep(relativeStorage, run.runId, stepId, 'step_completed', {
          result: new Uint8Array([i]),
        });

        const events = await relativeStorage.events.list({ runId: run.runId });
        expect(events.data).toHaveLength(2 + (i + 1) * 3);
      }

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads).toHaveLength(0);
    });

    it('reuses locally appended events for correlation queries', async () => {
      const stepId = 'cached-correlation-step';
      await createStep(storage, testRunId, {
        stepId,
        stepName: 'cached-correlation-step',
        input: new Uint8Array([1]),
      });
      await updateStep(storage, testRunId, stepId, 'step_started');
      const readFileSpy = vi.spyOn(fs, 'readFile');

      const events = await storage.events.listByCorrelationId({
        correlationId: stepId,
        pagination: {},
      });

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(events.data).toHaveLength(2);
      expect(eventFileReads).toHaveLength(0);
    });

    it('reads oversized event payloads from disk instead of retaining them', async () => {
      const created = await storage.events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'deployment-large',
          workflowName: 'large-event-workflow',
          input: new Uint8Array(4 * 1024 * 1024),
        },
      });
      const readFileSpy = vi.spyOn(fs, 'readFile');

      await storage.events.list({ runId: created.event.runId });

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads.length).toBeGreaterThan(0);
    });

    it('evicts old events once the recent-event byte bound is exceeded', async () => {
      const hookId = 'bounded-cache-hook';
      await createHook(storage, testRunId, {
        hookId,
        token: 'bounded-cache-token',
      });

      for (let i = 0; i < 4; i++) {
        await storage.events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hookId,
          eventData: { payload: new Uint8Array(1024 * 1024) },
        });
      }

      const readFileSpy = vi.spyOn(fs, 'readFile');
      await storage.events.list({ runId: testRunId });

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads.length).toBeGreaterThan(0);
    });

    it('normalizes cached event metadata the same way as disk reads', async () => {
      const created = await storage.events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'deployment-normalized',
          workflowName: 'normalized-cache-workflow',
          input: new Uint8Array([1]),
          executionContext: {
            timestamp: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      });

      const page = await storage.events.list({ runId: created.event.runId });

      expect((page.data[0] as any).eventData.executionContext.timestamp).toBe(
        '2026-01-01T00:00:00.000Z'
      );
    });

    it('allows active-event cache contents to be explicitly released', async () => {
      const localStorage = createStorage(testDir);
      const run = await createRun(localStorage, {
        deploymentId: 'deployment-clear',
        workflowName: 'cleared-cache-workflow',
        input: new Uint8Array([1]),
      });
      localStorage.clearCache();
      const readFileSpy = vi.spyOn(fs, 'readFile');

      await localStorage.events.list({ runId: run.runId });

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads.length).toBeGreaterThan(0);
    });

    it('releases locally cached events after a run completes', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-complete',
        workflowName: 'completed-cache-workflow',
        input: new Uint8Array([1]),
      });
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([2]),
      });
      const readFileSpy = vi.spyOn(fs, 'readFile');

      await storage.events.list({ runId: run.runId });

      const eventFileReads = readFileSpy.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}events${path.sep}`)
      );
      expect(eventFileReads.length).toBeGreaterThan(0);
    });
  });

  describe('hooks', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
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
        expect((result.event as any).eventData.conflictingRunId).toBe(
          testRunId
        );
        expect(result.hook).toBeUndefined();
      });

      it('reaps an unparseable claim of a live hook and recovers the real conflict from the event log', async () => {
        // A corrupt claim file whose hook is still live must not be trusted as
        // debris and stolen — but it also must not block the token forever.
        // The claimant loop reaps the unparseable file after a few observations
        // (nothing else deletes it — the releaser can't determine ownership),
        // then rebuilds the live hook's claim from the event log, so the
        // duplicate still conflicts and now carries the real conflicting run.
        const token = 'corrupt-claim-live-hook-token';

        await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token,
        });

        const claimPath = path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken(token)}.json`
        );
        await fs.writeFile(claimPath, '{');

        const result = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token },
        });

        expect(result.event.eventType).toBe('hook_conflict');
        expect((result.event as any).eventData.token).toBe(token);
        // Recovered from the event log rather than the unreadable claim.
        expect((result.event as any).eventData.conflictingRunId).toBe(
          testRunId
        );
        expect(result.hook).toBeUndefined();

        // The corrupt file was replaced by the live hook's real, parseable claim.
        const restored = JSON.parse(await fs.readFile(claimPath, 'utf8'));
        expect(restored).toMatchObject({
          token,
          hookId: 'hook_1',
          runId: testRunId,
        });
      });

      it('reaps an unparseable orphan claim so a new hook can reuse the token (#2808)', async () => {
        // Regression for the "unparseable claim blocks its token indefinitely"
        // gap: a corrupt claim with no live hook behind it (genuine debris —
        // e.g. a partial/corrupted write) is never reaped by the releaser
        // (ownership is undeterminable). The claimant loop must delete it after
        // N observations so the token becomes claimable again.
        const token = 'corrupt-orphan-claim-token';
        const claimPath = path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken(token)}.json`
        );
        await fs.mkdir(path.dirname(claimPath), { recursive: true });
        await fs.writeFile(claimPath, 'not-json{');

        const result = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook_new',
          eventData: { token },
        });

        expect(result.event.eventType).toBe('hook_created');
        expect(result.hook?.token).toBe(token);
        expect(result.hook?.hookId).toBe('hook_new');
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
        expect((conflictResult.event as any).eventData.conflictingRunId).toBe(
          testRunId
        );
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

      // Regression test for #2778: a claim whose owning run is terminal can
      // never become live again — a new claimant must treat it as vacant
      // instead of recording a hook_conflict against a finished run. The
      // claim file is rewritten manually to simulate the window where the
      // run-completion cleanup has not deleted it yet (or crashed).
      it('should treat a token claim owned by a terminal run as vacant', async () => {
        const token = 'terminal-owner-token';

        await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token,
        });
        await updateRun(storage, testRunId, 'run_started');
        await updateRun(storage, testRunId, 'run_completed', {
          output: new Uint8Array(),
        });

        // Simulate the stale claim surviving the terminal-run cleanup
        await fs.writeFile(
          path.join(testDir, 'hooks', 'tokens', `${hashToken(token)}.json`),
          JSON.stringify({
            token,
            hookId: 'hook_1',
            runId: testRunId,
            eventId: 'evnt_00000000000000000000000000',
          })
        );

        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'another-workflow',
          input: new Uint8Array(),
        });

        const result = await storage.events.create(run2.runId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token },
        });

        expect(result.event.eventType).toBe('hook_created');
        expect(result.hook?.runId).toBe(run2.runId);
      });

      // Regression test for #2778: the hook_disposed handler commits the
      // disposal (dispose lock) before deleting the token claim, so a new
      // claimant can observe the claim of a hook whose disposal is already
      // committed. It must treat that claim as vacant — and the event-log
      // rebuild must not resurrect the half-torn-down hook.
      it('should treat a token claim of a dispose-committed hook as vacant', async () => {
        const token = 'disposed-owner-token';

        await createHook(storage, testRunId, {
          hookId: 'hook_1',
          token,
        });

        // Simulate a disposer that crashed right after committing the
        // dispose lock, before deleting the claim and hook entity.
        const lockPath = hookDisposeLockPath(testDir, 'hook_1');
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, '');

        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'another-workflow',
          input: new Uint8Array(),
        });

        const result = await storage.events.create(run2.runId, {
          eventType: 'hook_created',
          correlationId: 'hook_2',
          eventData: { token },
        });

        expect(result.event.eventType).toBe('hook_created');
        expect(result.hook?.runId).toBe(run2.runId);
      });

      // Regression tests for the #2779 follow-up: a releaser (hook_disposed
      // handler or terminal-run cleanup) that stalls between reading the
      // hook entity and deleting the claim can outlive a force-release of
      // its stale claim — its deferred delete must not destroy the NEXT
      // claimant's live claim. The claim file is rewritten manually to
      // simulate the takeover happening during the stall.
      it('hook_disposed should not release a token claim it no longer owns', async () => {
        const token = 'stolen-claim-token';

        await createHook(storage, testRunId, {
          hookId: 'hook_old',
          token,
        });

        // Simulate a force-release + re-claim by a new claimant while the
        // disposer is stalled: the claim now points at (run2, hook_new).
        const claimPath = path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken(token)}.json`
        );
        const newClaim = {
          token,
          hookId: 'hook_new',
          runId: 'wrun_someother_run',
          eventId: 'evnt_00000000000000000000000001',
        };
        await fs.writeFile(claimPath, JSON.stringify(newClaim));

        // The stalled disposer's release lands now — it must skip the
        // deletion because the claim belongs to someone else.
        await disposeHook(storage, testRunId, 'hook_old');

        const claimAfter = JSON.parse(await fs.readFile(claimPath, 'utf8'));
        expect(claimAfter).toEqual(newClaim);
      });

      it('terminal-run hook cleanup should not release a token claim it no longer owns', async () => {
        const token = 'stolen-claim-token-terminal';

        await createHook(storage, testRunId, {
          hookId: 'hook_old',
          token,
        });

        const claimPath = path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken(token)}.json`
        );
        const newClaim = {
          token,
          hookId: 'hook_new',
          runId: 'wrun_someother_run',
          eventId: 'evnt_00000000000000000000000001',
        };
        await fs.writeFile(claimPath, JSON.stringify(newClaim));

        // Completing the run triggers deleteAllHooksForRun, which reads
        // hook_old's entity and releases its claim — it must skip the
        // deletion because the claim belongs to someone else.
        await updateRun(storage, testRunId, 'run_started');
        await updateRun(storage, testRunId, 'run_completed', {
          output: new Uint8Array(),
        });

        const claimAfter = JSON.parse(await fs.readFile(claimPath, 'utf8'));
        expect(claimAfter).toEqual(newClaim);
      });

      it('should enforce token uniqueness across different runs within the same project', async () => {
        // Create a second run
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'another-workflow',
          input: new Uint8Array(),
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
        expect((result.event as any).eventData.conflictingRunId).toBe(
          testRunId
        );
        expect(result.hook).toBeUndefined();
      });

      it('should reject concurrent creates for the same token atomically', async () => {
        const token = 'concurrent-token';

        // Fire 5 concurrent hook creations with the same token
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            storage.events.create(testRunId, {
              eventType: 'hook_created',
              correlationId: `concurrent_hook_${i}`,
              eventData: { token },
            })
          )
        );

        const fulfilled = results.filter(
          (r) => r.status === 'fulfilled'
        ) as PromiseFulfilledResult<any>[];
        const created = fulfilled.filter(
          (r) => r.value.event.eventType === 'hook_created'
        );
        const conflicts = fulfilled.filter(
          (r) => r.value.event.eventType === 'hook_conflict'
        );

        expect(created).toHaveLength(1);
        expect(conflicts).toHaveLength(4);
        for (const conflict of conflicts) {
          expect(conflict.value.event.eventData.conflictingRunId).toBe(
            testRunId
          );
        }
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
          'Hook not found'
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
        ).rejects.toThrow('Hook not found');
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
        // Should be in ascending order (oldest first) by default
        expect(result.data[0].hookId).toBe(hook1.hookId);
        expect(result.data[1].hookId).toBe(hook2.hookId);
        expect(result.data[0].createdAt.getTime()).toBeLessThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should filter hooks by runId', async () => {
        // Create a second run
        const run2 = await createRun(storage, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    describe('completed step', () => {
      it('should reject step_started on completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_terminal_1',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_1',
          'step_completed',
          {
            result: new Uint8Array([1]),
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
          input: new Uint8Array(),
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_2',
          'step_completed',
          {
            result: new Uint8Array([1]),
          }
        );

        await expect(
          updateStep(storage, testRunId, 'step_terminal_2', 'step_completed', {
            result: new Uint8Array([2]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on completed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_terminal_3',
          stepName: 'test-step',
          input: new Uint8Array(),
        });
        await updateStep(
          storage,
          testRunId,
          'step_terminal_3',
          'step_completed',
          {
            result: new Uint8Array([1]),
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
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });
        await updateStep(storage, testRunId, 'step_failed_2', 'step_failed', {
          error: 'Failed permanently',
        });

        await expect(
          updateStep(storage, testRunId, 'step_failed_2', 'step_completed', {
            result: new Uint8Array([3]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject step_failed on already failed step', async () => {
        await createStep(storage, testRunId, {
          stepId: 'step_failed_3',
          stepName: 'test-step',
          input: new Uint8Array(),
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
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });
        await updateStep(
          storage,
          testRunId,
          'step_completed_retry',
          'step_completed',
          {
            result: new Uint8Array([1]),
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

  describe('concurrent terminal state races', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
      await updateRun(storage, testRunId, 'run_started');
    });

    it('should reject concurrent step_completed for the same step', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_race_1',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(storage, testRunId, 'step_race_1', 'step_started');

      const results = await Promise.allSettled([
        updateStep(storage, testRunId, 'step_race_1', 'step_completed', {
          result: new Uint8Array([1]),
        }),
        updateStep(storage, testRunId, 'step_race_1', 'step_completed', {
          result: new Uint8Array([2]),
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });
    });

    it('should reject concurrent step_failed for the same step', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_race_2',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(storage, testRunId, 'step_race_2', 'step_started');

      const results = await Promise.allSettled([
        updateStep(storage, testRunId, 'step_race_2', 'step_failed', {
          error: 'err1',
        }),
        updateStep(storage, testRunId, 'step_race_2', 'step_failed', {
          error: 'err2',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });
    });

    it('should reject step_started after concurrent step_completed', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_race_3',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(storage, testRunId, 'step_race_3', 'step_started');
      await updateStep(storage, testRunId, 'step_race_3', 'step_completed', {
        result: new Uint8Array([1]),
      });

      // step_started on a completed step should be rejected
      await expect(
        updateStep(storage, testRunId, 'step_race_3', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject concurrent wait_completed for the same wait', async () => {
      await createWait(storage, testRunId, {
        waitId: 'wait_race_1',
        resumeAt: new Date('2099-01-01'),
      });

      const results = await Promise.allSettled([
        completeWait(storage, testRunId, 'wait_race_1'),
        completeWait(storage, testRunId, 'wait_race_1'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });
    });

    it('should reject concurrent hook_disposed for the same hook', async () => {
      await createHook(storage, testRunId, {
        hookId: 'hook_race_1',
        token: 'hook-race-token-1',
      });

      const results = await Promise.allSettled([
        disposeHook(storage, testRunId, 'hook_race_1'),
        disposeHook(storage, testRunId, 'hook_race_1'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Depending on timing, the loser may hit the lock file (EntityConflictError)
      // or find the hook entity already deleted (HookNotFoundError).
      const reason = (rejected[0] as PromiseRejectedResult).reason as {
        name?: string;
      };
      expect(['EntityConflictError', 'HookNotFoundError']).toContain(
        reason.name
      );

      // Verify only one hook_disposed event was written to the log
      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      const hookDisposedEvents = events.data.filter(
        (e) => e.eventType === 'hook_disposed'
      );
      expect(hookDisposedEvents).toHaveLength(1);
    });

    // Regression tests for #2781: a resume racing the hook's disposal must
    // never be journaled after hook_disposed — once that order is in the
    // log, every replay of the owning run diverges at the post-disposal
    // hook_received and the run escalates to CorruptedEventLogError.
    describe('hook_received vs. hook_disposed ordering (#2781)', () => {
      it('should reject hook_received once disposal has committed, even while the hook entity still exists', async () => {
        await createHook(storage, testRunId, {
          hookId: 'hook_mid_teardown',
          token: 'mid-teardown-token',
        });

        // Simulate a disposer mid-teardown (or crashed): the dispose lock
        // is durably committed but the hook entity has not been deleted
        // yet. The entity-existence check alone would accept the resume.
        const lockPath = hookDisposeLockPath(testDir, 'hook_mid_teardown');
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, '');

        await expect(
          storage.events.create(testRunId, {
            eventType: 'hook_received',
            correlationId: 'hook_mid_teardown',
            eventData: { payload: new Uint8Array([1]) },
          })
        ).rejects.toMatchObject({ name: 'HookNotFoundError' });

        const events = await storage.events.list({
          runId: testRunId,
          pagination: {},
        });
        expect(
          events.data.filter((e) => e.eventType === 'hook_received')
        ).toHaveLength(0);
      });

      // NOTE: a 20-round "race resume against disposal" soak test previously
      // lived here. It was removed as a regression guard: because both
      // orderings (resume-before-disposal and rejected-resume) are valid, the
      // loop passed even with the ordering fix reverted, so it was a soak, not
      // a deterministic guard. The mid-teardown test above (which forces the
      // committed-dispose-lock state) is the real regression guard for #2781.
    });
  });

  describe('concurrent entity-creation races', () => {
    let testRunId: string;
    beforeEach(async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      testRunId = run.runId;
      await updateRun(storage, testRunId, 'run_started');
    });

    it('should reject concurrent step_created with the same correlationId', async () => {
      // Two concurrent step_created calls with identical correlationIds
      // (as produced by the snapshot runtime's deterministic ULIDs across
      // concurrent VM invocations of the same resumption) must produce
      // exactly one step_created event in the log — not two. Without an
      // atomic guard the second writer overwrites the entity and persists
      // a duplicate event, causing downstream issues like double-queued
      // step messages.
      const results = await Promise.allSettled([
        createStep(storage, testRunId, {
          stepId: 'step_dup_1',
          stepName: 'test-step',
          input: new Uint8Array([1]),
        }),
        createStep(storage, testRunId, {
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
      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      const stepCreatedEvents = events.data.filter(
        (e) =>
          e.eventType === 'step_created' && e.correlationId === 'step_dup_1'
      );
      expect(stepCreatedEvents).toHaveLength(1);
    });

    it('should reject concurrent wait_created with the same correlationId', async () => {
      // wait_created previously used a TOCTOU read-then-check pattern that
      // could let both concurrent writers through. The atomic claim now
      // guarantees exactly one winner.
      const results = await Promise.allSettled([
        createWait(storage, testRunId, {
          waitId: 'wait_dup_1',
          resumeAt: new Date('2099-01-01'),
        }),
        createWait(storage, testRunId, {
          waitId: 'wait_dup_1',
          resumeAt: new Date('2099-01-02'),
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });

      // Verify only one wait_created event exists in the log.
      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      const waitCreatedEvents = events.data.filter(
        (e) =>
          e.eventType === 'wait_created' && e.correlationId === 'wait_dup_1'
      );
      expect(waitCreatedEvents).toHaveLength(1);
    });

    it('should reject duplicate correlated workflow attr_set events', async () => {
      await storage.events.create(testRunId, {
        eventType: 'attr_set',
        correlationId: 'attr_dup_1',
        eventData: {
          changes: [{ key: 'phase', value: 'running' }],
          writer: { type: 'workflow' },
        },
      });

      await expect(
        storage.events.create(testRunId, {
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
        storage.events.create(testRunId, {
          eventType: 'attr_set',
          correlationId: 'attr_dup_1',
          eventData: {
            changes: [{ key: 'phase', value: 'DIVERGED' }],
            writer: { type: 'workflow' },
          },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
      expect((await storage.runs.get(testRunId)).attributes?.phase).toBe(
        'running'
      );

      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        events.data.filter(
          (event) =>
            event.eventType === 'attr_set' &&
            event.correlationId === 'attr_dup_1'
        )
      ).toHaveLength(1);
    });

    it('should not claim the attr_set correlation lock when validation fails', async () => {
      // A validation failure must leave the correlationId unclaimed:
      // otherwise the runtime's retry of the same event would be rejected
      // with EntityConflictError ("already exists") while the event was
      // never written, and the workflow would replay forever waiting for
      // an event that is not in the log.
      await expect(
        storage.events.create(testRunId, {
          eventType: 'attr_set',
          correlationId: 'attr_validation_retry',
          eventData: {
            changes: [{ key: '$reserved', value: 'nope' }],
            writer: { type: 'workflow' },
          },
        })
      ).rejects.toThrow(/reserved prefix/);

      const retried = await storage.events.create(testRunId, {
        eventType: 'attr_set',
        correlationId: 'attr_validation_retry',
        eventData: {
          changes: [{ key: '$reserved', value: 'ok' }],
          writer: { type: 'workflow' },
          allowReservedAttributes: true,
        },
      });
      expect(retried.run?.attributes).toMatchObject({ $reserved: 'ok' });
    });

    it('should reject sequential duplicate step_created calls', async () => {
      // Sequential (non-racing) duplicates must also be rejected — the
      // constraint file persists across calls.
      await createStep(storage, testRunId, {
        stepId: 'step_seq_dup',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await expect(
        createStep(storage, testRunId, {
          stepId: 'step_seq_dup',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
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

      await createHook(storage, testRunId, { hookId, token });

      // Same runId, same hookId, same token — must be idempotent.
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // No hook_conflict event should have been written to the log.
      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      const hookCreatedEvents = events.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      const hookConflictEvents = events.data.filter(
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

      await createHook(storage, testRunId, { hookId: 'hook_a', token });

      const result = await storage.events.create(testRunId, {
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

      await createHook(storage, testRunId, { hookId, token });

      const otherRun = await createRun(storage, {
        deploymentId: 'deployment-other',
        workflowName: 'other-workflow',
        input: new Uint8Array(),
      });

      const result = await storage.events.create(otherRun.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });

      expect(result.event.eventType).toBe('hook_conflict');
      expect((result.event as any).eventData.conflictingRunId).toBe(testRunId);
      expect(result.hook).toBeUndefined();
    });

    it('should recover an orphaned hook token claim with no matching hook entity', async () => {
      // Crash-recovery regression: if a prior in-flight `hook_created`
      // wrote the token-claim file but exited before the hook entity
      // was written, the same-`(runId, hookId)` retry must not be
      // treated as a "real duplicate" — that would throw
      // EntityConflictError, which the runtime's concurrent-replay
      // catch path would swallow, permanently leaving the run with no
      // hook and no `hook_created` event in the log.
      //
      // The recovery path detects the missing hook entity and
      // completes the partial write: it (re-)writes the hook entity
      // and the outer code path emits the `hook_created` event.
      const token = 'orphaned-claim-token';
      const hookId = 'hook_orphan_1';

      // Pre-seed an orphaned token claim — same shape as one written
      // by `events.create` but with no corresponding hook entity on
      // disk. This simulates a crash between `writeExclusive(claim)`
      // and the hook entity write.
      const tokensDir = path.join(testDir, 'hooks', 'tokens');
      await fs.mkdir(tokensDir, { recursive: true });
      await fs.writeFile(
        path.join(tokensDir, `${hashToken(token)}.json`),
        JSON.stringify({ token, hookId, runId: testRunId, foo: 'bar' })
      );

      // Sanity: the hook entity is not on disk yet.
      await expect(storage.hooks.get(hookId)).rejects.toThrow(
        /not found|HookNotFoundError/i
      );

      // Retry: must succeed, write the hook entity, and emit a
      // hook_created event.
      const hook = await createHook(storage, testRunId, { hookId, token });
      expect(hook.hookId).toBe(hookId);
      expect(hook.token).toBe(token);

      // The hook entity is now durable.
      const retrieved = await storage.hooks.get(hookId);
      expect(retrieved.hookId).toBe(hookId);

      // The event log contains a hook_created event for this hookId
      // (and no hook_conflict event).
      const events = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      const created = events.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      const conflicts = events.data.filter(
        (e) => e.eventType === 'hook_conflict'
      );
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(0);
    });

    it('should recover an orphaned hook entity with no matching hook_created event', async () => {
      // Crash-recovery regression for the second window pranaygp
      // flagged on PR #2295: the claim file, the hook entity, and
      // the `hook_created` event are written by three separate non-
      // atomic operations. A crash after the entity write but before
      // the event write leaves both the claim file and the hook
      // entity on disk, but no `hook_created` event in the log. The
      // retry must NOT treat that as a "real duplicate" — it must
      // recover by emitting the missing event.
      //
      // This is exactly the scenario the dedup branch's event-log
      // probe handles. Without the probe (e.g. checking only the
      // hook entity), this test fails at the retry with
      // `EntityConflictError: Hook "hook_orphan_entity_1" already
      // created`.
      const token = 'orphaned-hook-entity-token';
      const hookId = 'hook_orphan_entity_1';

      const first = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(first.hook?.hookId).toBe(hookId);

      // Simulate a crash after the hook entity write but before the
      // event write by deleting the just-written event from disk.
      await fs.unlink(
        path.join(testDir, 'events', `${testRunId}-${first.event.eventId}.json`)
      );

      // Sanity: the hook entity is still durable but the
      // `hook_created` event is no longer in the log.
      await expect(storage.hooks.get(hookId)).resolves.toMatchObject({
        hookId,
        token,
      });
      const beforeRetry = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        beforeRetry.data.filter(
          (event) =>
            event.eventType === 'hook_created' && event.correlationId === hookId
        )
      ).toHaveLength(0);

      // Retry: must succeed and emit a `hook_created` event (no
      // `hook_conflict`, no swallowed EntityConflictError).
      const retry = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(retry.event.eventType).toBe('hook_created');

      const afterRetry = await storage.events.list({
        runId: testRunId,
        pagination: {},
      });
      expect(
        afterRetry.data.filter(
          (event) =>
            event.eventType === 'hook_created' && event.correlationId === hookId
        )
      ).toHaveLength(1);
      expect(
        afterRetry.data.filter((event) => event.eventType === 'hook_conflict')
      ).toHaveLength(0);
    });

    it('does not mutate an already-committed hook entity when a duplicate hook_created retry collides', async () => {
      // Regression for karthikscale3's review on PR #2295. The
      // dedup-recovery path used to write the hook entity BEFORE
      // the outer event publish proved whether this attempt was
      // repairing a missing event or just colliding with an
      // already-published `hook_created`. For an already-committed
      // duplicate, the event publish then throws
      // `EntityConflictError`, but the hook entity had already been
      // overwritten with the retry's payload — leaving the entity
      // and event log inconsistent (e.g. the entity reflects the
      // retry's metadata while the event still carries the
      // original).
      //
      // The fix defers the entity write until AFTER the event
      // publish succeeds, so a retry that ends in
      // EntityConflictError leaves the entity untouched.
      const token = 'no-mutate-on-duplicate-token';
      const hookId = 'hook_no_mutate_on_duplicate';
      const originalMetadata = new Uint8Array([0xaa]);
      const retryMetadata = new Uint8Array([0xbb]);

      // First write: original metadata + isWebhook: true.
      const first = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: {
          token,
          metadata: originalMetadata,
          isWebhook: true,
        },
      });
      expect(first.event.eventType).toBe('hook_created');
      expect(first.hook?.metadata).toEqual(originalMetadata);
      expect(first.hook?.isWebhook).toBe(true);

      // Retry with DIFFERENT metadata and isWebhook. This is the
      // adversarial input shape; in practice it would only come
      // from a caller bug, but the storage must not silently mutate
      // already-committed state under it.
      await expect(
        storage.events.create(testRunId, {
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
      // isWebhook — the retry's payload did NOT overwrite the
      // already-committed entity.
      const persisted = await storage.hooks.get(hookId);
      expect(persisted.metadata).toEqual(originalMetadata);
      expect(persisted.isWebhook).toBe(true);

      // And the event log still has exactly one hook_created event
      // for this hookId, with the original metadata.
      const events = await storage.events.list({
        runId: testRunId,
        pagination: { limit: 100 },
      });
      const hookCreated = events.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      expect(hookCreated).toHaveLength(1);
    });

    it('repairs an event-first orphan from the persisted event payload', async () => {
      // Regression for pranaygp's review on PR #2295 (the vercel-bot
      // edge-cases thread). Deferring the hook entity write until
      // after the event publish (the fix for the mutation bug above)
      // opens the inverse crash window: a crash AFTER the
      // `hook_created` event publish but BEFORE the deferred entity
      // write leaves the event in the log with no hook entity. A
      // retry then collides at the event publish and throws
      // `EntityConflictError` — correct, the event IS committed —
      // but the entity must be repaired from the PERSISTED event's
      // payload, not the retry's `eventData`. The retry here carries
      // deliberately different metadata so this test also prevents
      // reintroducing the prior mutation bug.
      const originalMetadata = new Uint8Array([0xaa]);
      const retryMetadata = new Uint8Array([0xbb]);
      const hookId = 'hook_event_first_orphan';
      const token = 'event-first-orphan-token';

      const first = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token, metadata: originalMetadata, isWebhook: true },
      });
      expect(first.event.eventType).toBe('hook_created');

      // Simulate a crash after the event publish but before the
      // deferred hook entity write.
      await fs.unlink(path.join(testDir, 'hooks', `${hookId}.json`));

      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token, metadata: retryMetadata, isWebhook: false },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // The hook entity was repaired from the persisted event's
      // payload — the ORIGINAL metadata and isWebhook, not the
      // retry's.
      await expect(storage.hooks.get(hookId)).resolves.toMatchObject({
        hookId,
        metadata: originalMetadata,
        isWebhook: true,
      });
      const events = await storage.events.list({
        runId: testRunId,
        pagination: { limit: 100 },
      });
      expect(
        events.data.filter(
          (event) =>
            event.eventType === 'hook_created' && event.correlationId === hookId
        )
      ).toHaveLength(1);
    });

    it('rebuilds missing hook caches from a committed hook_created event', async () => {
      // Regression for #2339: once hook_created is committed to the event log,
      // the hook entity and token claim are cache files. If both are missing
      // after a crash or upgrade, a normal hook read should rebuild them from
      // the persisted event instead of treating the hook/token as gone.
      const metadata = new Uint8Array([0xee]);
      const hookId = 'hook_event_log_rebuild';
      const token = 'event-log-rebuild-token';

      const created = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token, metadata, isWebhook: true },
      });
      expect(created.event.eventType).toBe('hook_created');

      const hookPath = path.join(testDir, 'hooks', `${hookId}.json`);
      const tokenClaimPath = path.join(
        testDir,
        'hooks',
        'tokens',
        `${hashToken(token)}.json`
      );
      await fs.unlink(hookPath);
      await fs.unlink(tokenClaimPath);
      await fs.writeFile(
        path.join(testDir, 'events', 'wrun_malformed-event.json'),
        '{'
      );

      const conflict = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook_event_log_rebuild_conflict',
        eventData: { token },
      });
      expect(conflict.event.eventType).toBe('hook_conflict');
      expect((conflict.event as any).eventData.conflictingRunId).toBe(
        testRunId
      );

      await fs.unlink(hookPath);
      await fs.unlink(tokenClaimPath);

      await expect(storage.hooks.get(hookId)).resolves.toMatchObject({
        runId: testRunId,
        hookId,
        token,
        metadata,
        isWebhook: true,
      });

      const claim = JSON.parse(await fs.readFile(tokenClaimPath, 'utf8'));
      expect(claim).toMatchObject({
        runId: testRunId,
        hookId,
        eventId: created.event.eventId,
      });
    });

    it('preserves legacy webhook default when rebuilding a hook without isWebhook', async () => {
      const metadata = new Uint8Array([0xab]);
      const hookId = 'hook_legacy_webhook_default';
      const token = 'legacy-webhook-default-token';
      const created = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token, metadata },
      });
      expect(created.event.eventType).toBe('hook_created');

      await fs.unlink(path.join(testDir, 'hooks', `${hookId}.json`));
      await fs.unlink(
        path.join(testDir, 'hooks', 'tokens', `${hashToken(token)}.json`)
      );

      await expect(storage.hooks.get(hookId)).resolves.toMatchObject({
        hookId,
        token,
        metadata,
        isWebhook: true,
      });
    });

    it('does not rebuild a hook for a run already marked terminal', async () => {
      const hookId = 'hook_terminal_run_cache';
      const token = 'terminal-run-cache-token';
      await createHook(storage, testRunId, { hookId, token });

      const hookPath = path.join(testDir, 'hooks', `${hookId}.json`);
      const tokenClaimPath = path.join(
        testDir,
        'hooks',
        'tokens',
        `${hashToken(token)}.json`
      );
      await fs.unlink(hookPath);
      await fs.unlink(tokenClaimPath);

      const run = await storage.runs.get(testRunId);
      await writeJSON(
        path.join(testDir, 'runs', `${testRunId}.json`),
        {
          ...run,
          status: 'cancelled',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
        { overwrite: true }
      );

      const nextRun = await createRun(storage, {
        deploymentId: 'deployment-next',
        workflowName: 'next-workflow',
        input: new Uint8Array(),
      });

      const created = await storage.events.create(nextRun.runId, {
        eventType: 'hook_created',
        correlationId: 'hook_terminal_run_cache_next',
        eventData: { token },
      });
      expect(created.event.eventType).toBe('hook_created');
      expect(created.hook?.runId).toBe(nextRun.runId);
    });

    it('repairs an event-first orphan via the legacy-claim probe path', async () => {
      // Same crash window as the test above, but exercised through
      // the legacy-claim branch: the claim file lacks `eventId` (as
      // written by a pre-upgrade version), so the retry takes the
      // event-log probe path. When the probe finds the committed
      // `hook_created` event, it must repair the missing entity from
      // the persisted event payload before throwing the benign
      // `EntityConflictError`.
      const originalMetadata = new Uint8Array([0xcc]);
      const retryMetadata = new Uint8Array([0xdd]);
      const hookId = 'hook_event_first_orphan_legacy';
      const token = 'event-first-orphan-legacy-token';

      const first = await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token, metadata: originalMetadata, isWebhook: true },
      });
      expect(first.event.eventType).toBe('hook_created');

      // Simulate the pre-upgrade crash state: the event is
      // committed, the hook entity is missing, and the claim file is
      // in the legacy format (no `eventId`).
      await fs.unlink(path.join(testDir, 'hooks', `${hookId}.json`));
      const constraintPath = path.join(
        testDir,
        'hooks',
        'tokens',
        `${hashToken(token)}.json`
      );
      await fs.writeFile(
        constraintPath,
        JSON.stringify({ token, hookId, runId: testRunId })
      );

      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token, metadata: retryMetadata, isWebhook: false },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      await expect(storage.hooks.get(hookId)).resolves.toMatchObject({
        hookId,
        metadata: originalMetadata,
        isWebhook: true,
      });
      const events = await storage.events.list({
        runId: testRunId,
        pagination: { limit: 100 },
      });
      expect(
        events.data.filter(
          (event) =>
            event.eventType === 'hook_created' && event.correlationId === hookId
        )
      ).toHaveLength(1);
    });

    it('converges same-hook creation across separate storage instances to one event', async () => {
      // Cross-instance convergence regression for the case pranaygp
      // flagged on PR #2295: separate workers (in production, separate
      // OS processes) sharing one data directory each have their own
      // in-process `hookLocks` Map; the mutex cannot serialize across
      // them. Without a durable cross-instance convergence key, both
      // workers can lose `writeExclusive(constraintPath)`, both
      // observe no `hook_created` event in the log, both fall through
      // to the recovery write, generate different `eventId`s, and
      // publish separate `hook_created` events.
      //
      // The fix persists `eventId` in the token claim so retries
      // adopt the canonical (winning) eventId and the outer event
      // write uses `writeExclusive` to atomically arbitrate
      // publication. Either worker may win the publish; the other
      // rejects with `EntityConflictError` (swallowed by the
      // runtime's existing concurrent-replay catch path). Net
      // result: exactly one `hook_created` event per logical
      // creation.
      //
      // Two `createStorage(testDir)` instances are equivalent to two
      // OS processes for this test — both have independent
      // `hookLocks` Maps but share the on-disk constraint / claim /
      // marker / event files. That is the substrate the
      // implementation is intended to protect, without the overhead
      // of `child_process.fork`.
      const workerA = createStorage(testDir);
      const workerB = createStorage(testDir);

      const run = await createRun(workerA, {
        deploymentId: 'deployment-workers',
        workflowName: 'worker-race',
        input: new Uint8Array(),
      });

      const attempts = 25;
      for (let i = 0; i < attempts; i++) {
        const correlationId = `hook_worker_${i}`;
        const token = `token-worker-${i}`;
        const results = await Promise.allSettled([
          workerA.events.create(run.runId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
          workerB.events.create(run.runId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected'
        );
        // Exactly one worker fulfills (publishes the canonical event);
        // the other rejects with EntityConflictError (swallowed by
        // the runtime's concurrent-replay catch path in production).
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        for (const r of rejected) {
          expect((r.reason as { name?: string })?.name).toBe(
            'EntityConflictError'
          );
        }
      }

      // Assert directly on a single raw `events.list()` result: there
      // must be exactly `attempts` `hook_created` events for the run,
      // one per logical creation. Do NOT deduplicate by eventId here
      // — that would hide a duplicate-publication regression.
      const allEvents = await storage.events.list({
        runId: run.runId,
        pagination: { limit: 1000 },
      });
      const hookCreated = allEvents.data.filter(
        (event) => event.eventType === 'hook_created'
      );
      const hookConflict = allEvents.data.filter(
        (event) => event.eventType === 'hook_conflict'
      );
      expect(hookCreated).toHaveLength(attempts);
      expect(hookConflict).toHaveLength(0);
    });

    it('converges same-hook creation across storage instances when only a legacy token claim exists', async () => {
      // Crash / upgrade-recovery regression: a token claim written by
      // a version of this storage that did not yet persist `eventId`
      // in the claim file (i.e. the pre-2283 layout `{ token, hookId,
      // runId }`) still exists on disk after upgrade. Two workers
      // both lose `writeExclusive(constraintPath)`, both read the
      // legacy claim, both see `existingClaim.eventId === undefined`,
      // and both fall to the legacy fallback. Without an atomic
      // cross-worker convergence point, both generate fresh
      // eventIds, both `writeExclusive(eventPath)` at different
      // paths, and both publish — yielding two `hook_created` events
      // for the same `(runId, hookId)`.
      //
      // The fix promotes the legacy claim to a canonical eventId via
      // a sidecar recovery marker (`hooks/tokens/<hash>.recovery.json`,
      // also a `writeExclusive`). The first worker to land the
      // marker pins its candidate eventId as canonical; all
      // subsequent workers read the marker and adopt that eventId.
      // Combined with the `writeExclusive(eventPath)` in the outer
      // publish, this gives the legacy-fallback path the same
      // single-event convergence guarantee as the inline-`eventId`
      // fast path.
      //
      // Existing persisted claims after a real-world upgrade are
      // exactly the state the crash-recovery branch needs to repair,
      // so leaving the legacy path non-convergent across workers is
      // not backward compatibility — it is silent corruption.
      const workerA = createStorage(testDir);
      const workerB = createStorage(testDir);

      const run = await createRun(workerA, {
        deploymentId: 'deployment-legacy',
        workflowName: 'legacy-race',
        input: new Uint8Array(),
      });

      const attempts = 25;
      for (let i = 0; i < attempts; i++) {
        const correlationId = `hook_legacy_${i}`;
        const token = `token-legacy-${i}`;

        // Pre-seed the legacy-format claim: present on disk, but
        // missing the `eventId` field this version adds.
        const tokensDir = path.join(testDir, 'hooks', 'tokens');
        await fs.mkdir(tokensDir, { recursive: true });
        await fs.writeFile(
          path.join(tokensDir, `${hashToken(token)}.json`),
          JSON.stringify({ token, hookId: correlationId, runId: run.runId })
        );

        const results = await Promise.allSettled([
          workerA.events.create(run.runId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
          workerB.events.create(run.runId, {
            eventType: 'hook_created',
            correlationId,
            eventData: { token },
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected'
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        for (const r of rejected) {
          expect((r.reason as { name?: string })?.name).toBe(
            'EntityConflictError'
          );
        }
      }

      // Raw event log must contain exactly `attempts` `hook_created`
      // events for the run.
      const allEvents = await storage.events.list({
        runId: run.runId,
        pagination: { limit: 1000 },
      });
      const hookCreated = allEvents.data.filter(
        (event) => event.eventType === 'hook_created'
      );
      const hookConflict = allEvents.data.filter(
        (event) => event.eventType === 'hook_conflict'
      );
      expect(hookCreated).toHaveLength(attempts);
      expect(hookConflict).toHaveLength(0);
    });

    it('legacy claim whose hook_created event was already published does not append a duplicate event', async () => {
      // Crash / upgrade-recovery regression for the VADE bot's
      // concern on PR #2295: a legacy token claim (no inline
      // `eventId`) for which the pre-upgrade writer already
      // successfully published the `hook_created` event. A post-
      // upgrade retry must dedup against the existing event, NOT
      // pin a new canonical eventId and publish a duplicate event
      // at the marker's path.
      //
      // The recovery-marker sidecar arbitrates concurrent retries
      // but has no way of knowing the pre-upgrade writer's eventId
      // after the fact. The fix probes the event log for an
      // existing `hook_created` event for `(runId, correlationId)`
      // before pinning the marker; if found, throws
      // EntityConflictError so the runtime's existing concurrent-
      // replay catch path swallows the retry.
      const run = await createRun(storage, {
        deploymentId: 'deployment-already-published',
        workflowName: 'already-published',
        input: new Uint8Array(),
      });

      const token = 'already-published-token';
      const hookId = 'hook_already_published';

      // Pre-seed the legacy claim format (`{ token, hookId, runId }`,
      // no `eventId`) AND an existing `hook_created` event written
      // by a (simulated) pre-upgrade writer with its own eventId.
      const tokensDir = path.join(testDir, 'hooks', 'tokens');
      await fs.mkdir(tokensDir, { recursive: true });
      await fs.writeFile(
        path.join(tokensDir, `${hashToken(token)}.json`),
        JSON.stringify({ token, hookId, runId: run.runId })
      );
      const preExistingEventId = 'evnt_pre_upgrade_existing';
      const eventsDir = path.join(testDir, 'events');
      await fs.mkdir(eventsDir, { recursive: true });
      await fs.writeFile(
        path.join(eventsDir, `${run.runId}-${preExistingEventId}.json`),
        JSON.stringify({
          eventType: 'hook_created',
          eventId: preExistingEventId,
          runId: run.runId,
          correlationId: hookId,
          createdAt: new Date().toISOString(),
          specVersion: 3,
          eventData: { token },
        })
      );

      // Retry must NOT publish a duplicate event.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        })
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // The raw event log still contains exactly one `hook_created`
      // event for this hookId (the pre-existing one, with its
      // original eventId).
      const allEvents = await storage.events.list({
        runId: run.runId,
        pagination: { limit: 1000 },
      });
      const hookCreated = allEvents.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      expect(hookCreated).toHaveLength(1);
      expect(hookCreated[0].eventId).toBe(preExistingEventId);
    });

    it('converges legacy claim recovery across run lifetimes after token reuse', async () => {
      // Stale-marker regression for the case pranaygp flagged on
      // PR #2295: a legacy claim is recovered for run A (creating a
      // marker), run A terminates through normal lifecycle
      // (`run_completed` triggers `deleteAllHooksForRun`), then the
      // same token is reused by a legacy claim for run B. Two
      // workers race to recover run B's claim.
      //
      // The previous, single-marker-per-token design left the run-A
      // marker on disk and let both run-B workers overwrite it
      // non-atomically, yielding multiple `hook_created` events for
      // run B's `(runId, hookId)`. The fix moves the marker key to
      // a hash of `(token, runId, hookId)` so run B's workers
      // contend on a distinct marker that no other lifetime can
      // touch.
      const workerA = createStorage(testDir);
      const workerB = createStorage(testDir);

      const runA = await createRun(workerA, {
        deploymentId: 'deployment-token-reuse-a',
        workflowName: 'token-reuse-a',
        input: new Uint8Array(),
      });

      const token = 'reused-across-lifetimes-token';
      const hookIdA = 'hook_reuse_run_a';
      const hookIdB = 'hook_reuse_run_b';

      // Run A: seed legacy claim, race recovery.
      const tokensDir = path.join(testDir, 'hooks', 'tokens');
      await fs.mkdir(tokensDir, { recursive: true });
      await fs.writeFile(
        path.join(tokensDir, `${hashToken(token)}.json`),
        JSON.stringify({ token, hookId: hookIdA, runId: runA.runId })
      );
      const runAResults = await Promise.allSettled([
        workerA.events.create(runA.runId, {
          eventType: 'hook_created',
          correlationId: hookIdA,
          eventData: { token },
        }),
        workerB.events.create(runA.runId, {
          eventType: 'hook_created',
          correlationId: hookIdA,
          eventData: { token },
        }),
      ]);
      expect(runAResults.filter((r) => r.status === 'fulfilled')).toHaveLength(
        1
      );

      // Terminate run A through normal lifecycle. This is the path
      // pranaygp called out: `deleteAllHooksForRun` deletes the
      // claim and hook entity but historically left the marker
      // behind for token reuse to trip on.
      await updateRun(storage, runA.runId, 'run_completed', {
        output: new Uint8Array(),
      });

      // Run B: same token, different (runId, hookId). Seed legacy
      // claim again — i.e. the token was reused by a workflow whose
      // claim was written by a still-running pre-upgrade producer.
      const runB = await createRun(workerA, {
        deploymentId: 'deployment-token-reuse-b',
        workflowName: 'token-reuse-b',
        input: new Uint8Array(),
      });
      await fs.writeFile(
        path.join(tokensDir, `${hashToken(token)}.json`),
        JSON.stringify({ token, hookId: hookIdB, runId: runB.runId })
      );

      const runBResults = await Promise.allSettled([
        workerA.events.create(runB.runId, {
          eventType: 'hook_created',
          correlationId: hookIdB,
          eventData: { token },
        }),
        workerB.events.create(runB.runId, {
          eventType: 'hook_created',
          correlationId: hookIdB,
          eventData: { token },
        }),
      ]);
      const runBFulfilled = runBResults.filter((r) => r.status === 'fulfilled');
      const runBRejected = runBResults.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(runBFulfilled).toHaveLength(1);
      expect(runBRejected).toHaveLength(1);
      for (const r of runBRejected) {
        expect((r.reason as { name?: string })?.name).toBe(
          'EntityConflictError'
        );
      }

      // Run B's event log has exactly one `hook_created` event for
      // hookIdB — not the divergent multi-event result a leaked
      // run-A marker would have produced.
      const runBEvents = await storage.events.list({
        runId: runB.runId,
        pagination: { limit: 1000 },
      });
      const hookCreated = runBEvents.data.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookIdB
      );
      const hookConflict = runBEvents.data.filter(
        (e) => e.eventType === 'hook_conflict'
      );
      expect(hookCreated).toHaveLength(1);
      expect(hookConflict).toHaveLength(0);
    });
  });

  describe('run terminal state validation', () => {
    describe('completed run', () => {
      it('should reject run_started on completed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: new Uint8Array([3]),
        });

        await expect(
          updateRun(storage, run.runId, 'run_started')
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on completed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: new Uint8Array([3]),
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
          input: new Uint8Array(),
        });
        await updateRun(storage, run.runId, 'run_completed', {
          output: new Uint8Array([3]),
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
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });
        await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

        await expect(
          updateRun(storage, run.runId, 'run_completed', {
            output: new Uint8Array([4]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_cancelled on failed run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
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
          input: new Uint8Array(),
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
          input: new Uint8Array(),
        });
        await storage.events.create(run.runId, { eventType: 'run_cancelled' });

        await expect(
          updateRun(storage, run.runId, 'run_completed', {
            output: new Uint8Array([4]),
          })
        ).rejects.toThrow(/terminal/i);
      });

      it('should reject run_failed on cancelled run', async () => {
        const run = await createRun(storage, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
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
        input: new Uint8Array(),
      });

      // Create and start a step (making it in-progress)
      await createStep(storage, run.runId, {
        stepId: 'step_in_progress',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(storage, run.runId, 'step_in_progress', 'step_started');

      // Complete the run while step is still running
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

      // Should succeed - completing an in-progress step on a terminal run is allowed
      const result = await updateStep(
        storage,
        run.runId,
        'step_in_progress',
        'step_completed',
        { result: new Uint8Array([1]) }
      );
      expect(result.status).toBe('completed');
    });

    it('should allow step_failed on completed run for in-progress step', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create and start a step
      await createStep(storage, run.runId, {
        stepId: 'step_in_progress_fail',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(
        storage,
        run.runId,
        'step_in_progress_fail',
        'step_started'
      );

      // Complete the run
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

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
        input: new Uint8Array(),
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
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

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
        input: new Uint8Array(),
      });
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started on completed run for pending step', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create a step but don't start it
      await createStep(storage, run.runId, {
        stepId: 'pending_step',
        stepName: 'test-step',
        input: new Uint8Array(),
      });

      // Complete the run
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

      // Should reject - cannot start a pending step on a terminal run
      await expect(
        updateStep(storage, run.runId, 'pending_step', 'step_started')
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on completed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

      await expect(
        createHook(storage, run.runId, {
          hookId: 'new_hook',
          token: 'new-token',
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject attr_set on completed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([3]),
      });

      await expect(
        storage.events.create(run.runId, {
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
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await updateRun(storage, run.runId, 'run_failed', { error: 'Failed' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_failed',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on cancelled run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_cancelled',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on failed run', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
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
        input: new Uint8Array(),
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
        input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    it('should set step status to pending and record error', async () => {
      await createStep(storage, testRunId, {
        stepId: 'step_retry_1',
        stepName: 'test-step',
        input: new Uint8Array(),
      });
      await updateStep(storage, testRunId, 'step_retry_1', 'step_started');

      // The `error` field is opaque SerializedData (Uint8Array) produced by
      // dehydrateStepError. The storage layer persists it verbatim.
      const serializedError = new Uint8Array([9, 9, 9]);
      const result = await storage.events.create(testRunId, {
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
      await createStep(storage, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      await updateStep(
        storage,
        testRunId,
        'step_retry_completed',
        'step_completed',
        {
          result: new Uint8Array([1]),
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
        input: new Uint8Array(),
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
        input: new Uint8Array(),
      });

      // Create and start a step
      await createStep(storage, run.runId, {
        stepId: 'step_in_flight',
        stepName: 'test-step',
        input: new Uint8Array(),
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
        { result: new Uint8Array([1]) }
      );
      expect(result.status).toBe('completed');
    });

    it('should reject step_created after run cancelled', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        createStep(storage, run.runId, {
          stepId: 'new_step_after_cancel',
          stepName: 'test-step',
          input: new Uint8Array(),
        })
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started for pending step after run cancelled', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // Create a step but don't start it
      await createStep(storage, run.runId, {
        stepId: 'pending_after_cancel',
        stepName: 'test-step',
        input: new Uint8Array(),
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
        input: new Uint8Array(),
      });
      testRunId = run.runId;
    });

    it('should reject step_completed before step_created', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'nonexistent_step',
          eventData: { result: new Uint8Array([1]) },
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
        input: new Uint8Array(),
      });

      // Should succeed - instant completion without starting
      const result = await updateStep(
        storage,
        testRunId,
        'instant_complete',
        'step_completed',
        { result: new Uint8Array([1]) }
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
        input: new Uint8Array(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await writeJSON(path.join(runsDir, `${runId}.json`), run);
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

      it('should handle hook_received on legacy run', async () => {
        const runId = 'wrun_legacy_hook_received';
        await createLegacyRun(runId, 1);

        const result = await storage.events.create(runId, {
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
          storage.events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/not supported for legacy runs/i);

        // run_completed is not supported for legacy runs
        await expect(
          storage.events.create(runId, {
            eventType: 'run_completed',
            eventData: { output: new Uint8Array([3]) },
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
          input: new Uint8Array(),
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

  describe('custom runId validation', () => {
    const runCreatedEvent = {
      eventType: 'run_created' as const,
      eventData: {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      },
    };

    /**
     * Encode a timestamp into a Crockford base32 ULID timestamp component (10 chars).
     */
    function encodeUlidTime(timeMs: number): string {
      const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let result = '';
      let remaining = timeMs;
      for (let i = 0; i < 10; i++) {
        result = chars[remaining % 32] + result;
        remaining = Math.floor(remaining / 32);
      }
      return result;
    }

    function makeRunId(timestampMs: number): string {
      // 10-char encoded timestamp + 16 random chars
      return `wrun_${encodeUlidTime(timestampMs)}${'0'.repeat(16)}`;
    }

    it('should accept a client-provided runId with current timestamp', async () => {
      const runId = makeRunId(Date.now());
      const result = await storage.events.create(runId, runCreatedEvent);

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
    });

    it('should accept a runId within the threshold', async () => {
      // 4 minutes ago — within the 24-hour past threshold
      const runId = makeRunId(Date.now() - 4 * 60 * 1000);
      const result = await storage.events.create(runId, runCreatedEvent);

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
    });

    it('should accept a runId with a timestamp 10 minutes in the past', async () => {
      // 10 minutes ago — within the 24-hour past threshold
      const runId = makeRunId(Date.now() - 10 * 60 * 1000);
      const result = await storage.events.create(runId, runCreatedEvent);
      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
    });

    it('should reject a runId with a timestamp too far in the past', async () => {
      // 25 hours ago — exceeds the 24-hour past threshold
      const runId = makeRunId(Date.now() - 25 * 60 * 60 * 1000);

      await expect(
        storage.events.create(runId, runCreatedEvent)
      ).rejects.toThrow(WorkflowWorldError);

      await expect(
        storage.events.create(runId, runCreatedEvent)
      ).rejects.toThrow(/Invalid runId timestamp/);
    });

    it('should accept a runId with a timestamp 10 minutes in the past', async () => {
      // 10 minutes ago — within the 24-hour past threshold
      const runId = makeRunId(Date.now() - 10 * 60 * 1000);
      const result = await storage.events.create(runId, runCreatedEvent);
      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
    });

    it('should reject a runId with a timestamp too far in the future', async () => {
      // 10 minutes from now — exceeds the 5-minute future threshold
      const runId = makeRunId(Date.now() + 10 * 60 * 1000);

      await expect(
        storage.events.create(runId, runCreatedEvent)
      ).rejects.toThrow(WorkflowWorldError);

      await expect(
        storage.events.create(runId, runCreatedEvent)
      ).rejects.toThrow(/Invalid runId timestamp/);
    });

    it('should reject a runId that is not a valid ULID', async () => {
      await expect(
        storage.events.create('wrun_not-a-valid-ulid!!!!!!!!', runCreatedEvent)
      ).rejects.toThrow(WorkflowWorldError);

      await expect(
        storage.events.create('wrun_not-a-valid-ulid!!!!!!!!', runCreatedEvent)
      ).rejects.toThrow(/not a valid ULID/);
    });

    it('should not validate runId for non-run_created events', async () => {
      // Create a valid run first
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });

      // run_started with the server-generated runId should work fine
      const result = await storage.events.create(run.runId, {
        eventType: 'run_started',
      });

      expect(result.run?.status).toBe('running');
    });

    it('should not validate when runId is null (server-generated)', async () => {
      const result = await storage.events.create(null, runCreatedEvent);

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toMatch(/^wrun_/);
    });
  });

  // Regression tests for VULN-916: path-traversal via request-controlled IDs.
  //
  // Prior to the fix, a client could supply a `runId` like `../../../package`
  // and cause the backend to read/write files outside the storage root, since
  // the IDs flowed straight into `path.join(basedir, 'runs', ...)`. The
  // sanitization in `assertSafeEntityId` rejects any separator/`..`/leading
  // dot before the value is used in a filesystem path.
  describe('path traversal prevention (VULN-916)', () => {
    const traversalIds = [
      '../../../package',
      '../runs/wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '../nonexistent/wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'a/b',
      'a\\b',
      '.hidden',
      '.locks',
    ];

    for (const runId of traversalIds) {
      it(`rejects traversal runId on events.create: ${JSON.stringify(runId)}`, async () => {
        await expect(
          storage.events.create(runId, { eventType: 'run_started' })
        ).rejects.toThrow(/Unsafe runId/);
      });

      it(`rejects traversal runId on runs.get: ${JSON.stringify(runId)}`, async () => {
        await expect(storage.runs.get(runId)).rejects.toThrow(/Unsafe runId/);
      });

      it(`rejects traversal runId on steps.list: ${JSON.stringify(runId)}`, async () => {
        await expect(storage.steps.list({ runId } as any)).rejects.toThrow(
          /Unsafe runId/
        );
      });

      it(`rejects traversal runId on events.list: ${JSON.stringify(runId)}`, async () => {
        await expect(storage.events.list({ runId } as any)).rejects.toThrow(
          /Unsafe runId/
        );
      });
    }

    it('rejects traversal stepId on steps.get', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await expect(storage.steps.get(run.runId, '../escape')).rejects.toThrow(
        /Unsafe stepId/
      );
    });

    it('rejects traversal correlationId on events.create', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: '../escape',
        })
      ).rejects.toThrow(/Unsafe correlationId/);
    });

    // Empty correlationId would be accepted by the event schema (which only
    // requires `z.string()`) and produce composite keys like `${runId}-`,
    // leaving malformed entities/events in storage. Reject it up front.
    it('rejects empty correlationId on step_created', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: '',
          eventData: { stepName: 'step', input: new Uint8Array() },
        })
      ).rejects.toThrow(/Unsafe correlationId/);
    });

    it('rejects empty correlationId on hook_created', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: '',
          eventData: { token: 'tok' },
        })
      ).rejects.toThrow(/Unsafe correlationId/);
    });

    it('rejects empty correlationId on wait_created', async () => {
      const run = await createRun(storage, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      });
      await expect(
        storage.events.create(run.runId, {
          eventType: 'wait_created',
          correlationId: '',
          eventData: { resumeAt: new Date(Date.now() + 1000) },
        })
      ).rejects.toThrow(/Unsafe correlationId/);
    });

    it('rejects traversal hookId on hooks.get', async () => {
      await expect(storage.hooks.get('../escape')).rejects.toThrow(
        /Unsafe hookId/
      );
    });
  });
});
