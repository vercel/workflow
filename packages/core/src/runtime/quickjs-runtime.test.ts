import type { Event, RunInput, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

// No encryption key = encryption disabled
const noKey = undefined;

/** Build a workflow-mode bundle that registers `name` into __private_workflows. */
function bundle(name: string, source: string): string {
  return `${source}
;globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set(${JSON.stringify(name)}, ${name});`;
}

function makeRun(workflowName: string): WorkflowRun {
  return {
    runId: 'wrun_qjs_test',
    workflowName,
    status: 'running',
    input: new Uint8Array(),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  } as WorkflowRun;
}

async function runInputFor(args: unknown[]): Promise<RunInput> {
  const ops: Promise<unknown>[] = [];
  const input = await dehydrateWorkflowArguments(
    args,
    'wrun_qjs_test',
    noKey,
    ops
  );
  await Promise.all(ops);
  return { input } as RunInput;
}

async function hydrate(bytes: Uint8Array): Promise<unknown> {
  const ops: Promise<unknown>[] = [];
  const value = await hydrateWorkflowReturnValue(
    bytes as any,
    'wrun_qjs_test',
    noKey,
    ops
  );
  await Promise.all(ops);
  return value;
}

describe('runQuickJSWorkflow', () => {
  it('completes a simple workflow with no arguments', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle('wf', 'function wf() { return "success"; }'),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    expect(result.failed).toBeUndefined();
    expect(result.suspended).toBeUndefined();
    expect(result.completed).toBeDefined();
    expect(await hydrate(result.completed!.result)).toBe('success');
  });

  it('completes a workflow using its arguments', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle('wf', 'function wf(a, b) { return a + b; }'),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([2, 3]),
    });

    expect(result.completed).toBeDefined();
    expect(await hydrate(result.completed!.result)).toBe(5);
  });

  it('round-trips structured values (Date, Map) through the VM serde', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle(
        'wf',
        'function wf() { return { when: new Date(0), m: new Map([["a", 1]]) }; }'
      ),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    const value = (await hydrate(result.completed!.result)) as {
      when: Date;
      m: Map<string, number>;
    };
    expect(value.when).toBeInstanceOf(Date);
    expect(value.when.getTime()).toBe(0);
    expect(value.m).toBeInstanceOf(Map);
    expect(value.m.get('a')).toBe(1);
  });

  it('suspends with a pending step when a step has no result yet', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle(
        'wf',
        `async function wf() {
           const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
           return await step(1, 2);
         }`
      ),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    expect(result.completed).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(result.suspended).toBeDefined();
    const steps = result.suspended!.pendingOperations.filter(
      (p) => p.type === 'step'
    );
    expect(steps).toHaveLength(1);
    expect((steps[0] as { stepId: string }).stepId).toBe('step//test//add');
  });

  it('advances Date.now() along the event timeline across a step', async () => {
    const startedAt = new Date('2024-01-01T00:00:00.000Z');
    const stepCompletedAt = new Date('2024-01-01T00:05:00.000Z'); // +5 min
    const code = bundle(
      'wf',
      `async function wf() {
         const t0 = Date.now();
         const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//s");
         await step();
         const t1 = Date.now();
         return { t0, t1 };
       }`
    );
    const run = { ...makeRun('wf'), startedAt } as WorkflowRun;

    // Phase 1: run with no events → suspends; capture the deterministic cid.
    const suspended = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'wf',
      workflowRun: run,
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });
    const cid = suspended.suspended!.pendingOperations[0]!.correlationId;

    // Phase 2: replay with step_created + step_completed carrying timestamps.
    const ops: Promise<unknown>[] = [];
    const resultBytes = await dehydrateStepReturnValue(
      'done',
      run.runId,
      noKey,
      ops
    );
    await Promise.all(ops);
    const events: Event[] = [
      {
        eventId: 'e1',
        eventType: 'step_created',
        correlationId: cid,
        createdAt: startedAt,
        eventData: { stepName: 'step//test//s' },
      } as unknown as Event,
      {
        eventId: 'e2',
        eventType: 'step_completed',
        correlationId: cid,
        createdAt: stepCompletedAt,
        eventData: { result: resultBytes },
      } as unknown as Event,
    ];

    const completed = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'wf',
      workflowRun: run,
      events,
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    expect(completed.completed).toBeDefined();
    const value = (await hydrate(completed.completed!.result)) as {
      t0: number;
      t1: number;
    };
    expect(value.t0).toBe(startedAt.getTime());
    expect(value.t1).toBe(stepCompletedAt.getTime());
  });

  it('reports a workflow that throws as failed', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle(
        'wf',
        'function wf() { throw new TypeError("boom"); }'
      ),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    expect(result.completed).toBeUndefined();
    expect(result.failed).toBeDefined();
    expect(result.failed!.message).toContain('boom');
    expect(result.failed!.name).toBe('TypeError');
  });

  it('throws WorkflowNotRegisteredError name when the workflow is missing', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: bundle('other', 'function other() { return 1; }'),
      workflowId: 'wf',
      workflowRun: makeRun('wf'),
      events: [],
      encryptionKey: noKey,
      runInput: await runInputFor([]),
    });

    expect(result.failed).toBeDefined();
    expect(result.failed!.name).toBe('WorkflowNotRegisteredError');
  });
});
