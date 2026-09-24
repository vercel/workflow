import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { dehydrateStepReturnValue } from '../serialization.js';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { startQuickJSWorkflow } from './quickjs-runtime.js';
import { executeStep, type StepExecutionResult } from './step-executor.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));
vi.mock('./quickjs-runtime.js', () => ({ startQuickJSWorkflow: vi.fn() }));
vi.mock('./step-executor.js', () => ({ executeStep: vi.fn() }));

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('quietly joins a fresh inline step from an overlapping QuickJS invocation until the owner settles', async () => {
  vi.stubEnv('DEBUG', '');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const debug = vi.spyOn(runtimeLogger, 'debug');
  const runId = 'wrun_quickjs_contention';
  const stepId = 'step_quickjs_contention';
  const now = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_quickjs_contention',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const result = await dehydrateStepReturnValue('done', runId, undefined);
  const terminal: Event = {
    runId,
    eventId: 'evnt_step_completed',
    eventType: 'step_completed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    createdAt: now,
    eventData: { result },
  };
  let completed = false;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: async () => ({
        data: completed ? [terminal] : [],
        cursor: null,
        hasMore: false,
      }),
      create: async (_runId: string, request: CreateEventRequest) => ({
        event: { ...request, runId, eventId: 'evnt_run_completed' },
      }),
    },
    runs: { get: async () => workflowRun },
    getEncryptionKeyForRun: async () => undefined,
  } as unknown as World);

  vi.mocked(startQuickJSWorkflow).mockImplementation(async () => ({
    result: {
      suspended: {
        pendingOperations: [
          {
            type: 'step',
            correlationId: stepId,
            stepId: 'step//contention//run',
            input: new Uint8Array(),
            hasCreatedEvent: false,
          },
        ],
      },
    },
    continueWithEvents: vi.fn(async () => ({ completed: { result } })),
    dispose: vi.fn(),
  }));
  let release!: (value: StepExecutionResult) => void;
  const body = new Promise<StepExecutionResult>((resolve) => {
    release = resolve;
  });
  vi.mocked(executeStep).mockImplementation(() => body);
  const settled = [false, false];
  const run = (index: number) =>
    runWorkflowWithQuickJS({
      workflowCode: '',
      workflowName: workflowRun.workflowName,
      workflowRun,
    }).then(() => {
      settled[index] = true;
    });
  const invocations = [run(0), run(1)];
  try {
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('Step execution already in flight'),
        { workflowRunId: runId, stepId }
      )
    );
    expect(executeStep).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(settled).toEqual([false, false]);
  } finally {
    completed = true;
    release({ type: 'completed' });
    await Promise.all(invocations);
  }
  expect(settled).toEqual([true, true]);
  expect(executeStep).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});
