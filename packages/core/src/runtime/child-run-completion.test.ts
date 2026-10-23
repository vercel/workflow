import type { Event, WorkflowRun } from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import type {
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { serialize } from '../serialization/workflow-vm.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { runWorkflow } from '../workflow.js';
import {
  awaitChildRunCompletion,
  CHILD_RUN_COMPLETION_TOKEN_PREFIX,
  childRunCompletionToken,
} from './child-run-completion.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

const PARENT_RUN_ID = 'wrun_parent';
const CHILD_RUN_ID = 'wrun_child';
const READ_STEP = 'step//test//readReturnValue';
const TOKEN = childRunCompletionToken(CHILD_RUN_ID);

// The helper is evaluated inside the workflow VM in real bundles (it is
// imported by the workflow-mode `Run`). It imports nothing at runtime, so its
// source plus the module constants it closes over can be injected as is.
const helperSource = `
const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
const COMPLETION_WAITS = Symbol.for('@workflow/core//childRunCompletionWaits');
const CHILD_RUN_COMPLETION_TOKEN_PREFIX = ${JSON.stringify(CHILD_RUN_COMPLETION_TOKEN_PREFIX)};
${childRunCompletionToken.toString()}
${awaitChildRunCompletion.toString()}
const readReturnValue = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(READ_STEP)});
`;

function workflowCode(body: string): string {
  return `${helperSource}
async function workflow() {
  ${body}
}
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set("workflow", workflow);`;
}

/** `run.returnValue` for a handle whose recorded parent is `parentRunId`. */
const awaitChild = (parentRunId = PARENT_RUN_ID) =>
  `(awaitChildRunCompletion(${JSON.stringify(CHILD_RUN_ID)}, ${JSON.stringify(parentRunId)}, (wait) => readReturnValue(wait)) ?? readReturnValue(true).then((r) => r.value))`;

async function makeRun(): Promise<WorkflowRun> {
  return {
    runId: PARENT_RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], PARENT_RUN_ID, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

type Outcome =
  | { done: true; value: unknown }
  | {
      done: false;
      hooks: HookInvocationQueueItem[];
      steps: StepInvocationQueueItem[];
    };

async function replay(code: string, events: Event[]): Promise<Outcome> {
  const run = await makeRun();
  try {
    const result = await runWorkflow(code, run, events, undefined);
    return {
      done: true,
      value: await hydrateWorkflowReturnValue(
        result as any,
        PARENT_RUN_ID,
        undefined,
        []
      ),
    };
  } catch (err) {
    if ((err as Error).name !== 'WorkflowSuspension') throw err;
    const { items } = err as WorkflowSuspension;
    return {
      done: false,
      hooks: items.filter(
        (item): item is HookInvocationQueueItem => item.type === 'hook'
      ),
      steps: items.filter(
        (item): item is StepInvocationQueueItem => item.type === 'step'
      ),
    };
  }
}

function suspended(outcome: Outcome) {
  if (outcome.done) {
    throw new Error(
      `expected a suspension, got ${JSON.stringify(outcome.value)}`
    );
  }
  return outcome;
}

let eventSeq = 0;
function event(fields: Omit<Event, 'eventId' | 'runId' | 'createdAt'>): Event {
  return {
    eventId: `evnt_${String(eventSeq++).padStart(4, '0')}`,
    runId: PARENT_RUN_ID,
    createdAt: new Date(),
    ...fields,
  } as Event;
}

const hookCreated = (hook: HookInvocationQueueItem) =>
  event({
    eventType: 'hook_created',
    correlationId: hook.correlationId,
    eventData: { token: hook.token },
  } as any);

const hookReceived = async (hook: HookInvocationQueueItem) =>
  event({
    eventType: 'hook_received',
    correlationId: hook.correlationId,
    eventData: {
      token: hook.token,
      payload: await dehydrateStepReturnValue(
        { status: 'completed' },
        PARENT_RUN_ID,
        undefined,
        []
      ),
    },
  } as any);

const hookConflict = (hook: HookInvocationQueueItem) =>
  event({
    eventType: 'hook_conflict',
    correlationId: hook.correlationId,
    eventData: { token: hook.token, conflictingRunId: 'wrun_other' },
  } as any);

const stepCompleted = async (
  step: StepInvocationQueueItem,
  result: unknown
) => [
  event({
    eventType: 'step_started',
    correlationId: step.correlationId,
    eventData: { stepName: step.stepName },
  } as any),
  event({
    eventType: 'step_completed',
    correlationId: step.correlationId,
    eventData: {
      stepName: step.stepName,
      result: await dehydrateStepReturnValue(
        result,
        PARENT_RUN_ID,
        undefined,
        []
      ),
    },
  } as any),
];

describe('awaitChildRunCompletion', () => {
  it('returns undefined outside the workflow VM', () => {
    expect(
      awaitChildRunCompletion(CHILD_RUN_ID, PARENT_RUN_ID, async () => ({
        done: false,
      }))
    ).toBeUndefined();
  });

  it('returns undefined for a handle with no recorded parent', () => {
    expect(
      awaitChildRunCompletion(CHILD_RUN_ID, undefined, async () => ({
        done: false,
      }))
    ).toBeUndefined();
  });

  it('suspends on the completion hook while the child runs, then reads the finished child', async () => {
    const code = workflowCode(`return await ${awaitChild()};`);
    const events: Event[] = [];

    // 1. The hook is registered before anything reads the child.
    let outcome = suspended(await replay(code, events));
    expect(outcome.steps).toHaveLength(0);
    expect(outcome.hooks).toHaveLength(1);
    const [hook] = outcome.hooks;
    expect(hook.token).toBe(TOKEN);
    expect(hook.token).toBe(`wkf_child_run_completion:${CHILD_RUN_ID}`);
    expect(hook.hasConflictAwaiter).toBe(true);
    events.push(hookCreated(hook));

    // 2. Once registered, the child is read once, without waiting.
    outcome = suspended(await replay(code, events));
    expect(outcome.steps).toHaveLength(1);
    const [check] = outcome.steps;
    expect(check.stepName).toBe(READ_STEP);
    expect(check.args).toEqual([false]);
    events.push(...(await stepCompleted(check, { done: false })));

    // 3. Still running: the workflow parks on the hook and schedules nothing.
    outcome = suspended(await replay(code, events));
    expect(outcome.steps).toHaveLength(0);

    // 4. The child resumed the hook: read its (now terminal) result.
    events.push(await hookReceived(hook));
    outcome = suspended(await replay(code, events));
    expect(outcome.steps).toHaveLength(1);
    const [fetch] = outcome.steps;
    expect(fetch.args).toEqual([true]);
    events.push(...(await stepCompleted(fetch, { done: true, value: 42 })));

    expect(await replay(code, events)).toEqual({ done: true, value: 42 });
  });

  it('answers from the first read when the child already finished', async () => {
    const code = workflowCode(`return await ${awaitChild()};`);
    const events: Event[] = [];

    let outcome = suspended(await replay(code, events));
    const [hook] = outcome.hooks;
    events.push(hookCreated(hook));

    outcome = suspended(await replay(code, events));
    const [check] = outcome.steps;
    expect(check.args).toEqual([false]);
    events.push(
      ...(await stepCompleted(check, { done: true, value: 'early' }))
    );

    expect(await replay(code, events)).toEqual({ done: true, value: 'early' });
  });

  it('disposes the hook once the child has been read', async () => {
    // A later suspension (a plain step after the await) carries the hook's
    // disposal, so its token is released while the parent keeps running.
    const code = workflowCode(`
      const value = await ${awaitChild()};
      await readReturnValue('after');
      return value;
    `);
    const events: Event[] = [];
    let outcome = suspended(await replay(code, events));
    const [hook] = outcome.hooks;
    events.push(hookCreated(hook));
    outcome = suspended(await replay(code, events));
    events.push(
      ...(await stepCompleted(outcome.steps[0], { done: true, value: 1 }))
    );

    outcome = suspended(await replay(code, events));
    expect(outcome.steps.map((step) => step.args)).toEqual([['after']]);
    expect(outcome.hooks).toHaveLength(1);
    expect(outcome.hooks[0].correlationId).toBe(hook.correlationId);
    expect(outcome.hooks[0].disposed).toBe(true);
  });

  it('shares one hook between repeated awaits of the same child', async () => {
    const code = workflowCode(`
      const [a, b] = await Promise.all([${awaitChild()}, ${awaitChild()}]);
      return [a, b];
    `);
    const outcome = suspended(await replay(code, []));
    expect(outcome.hooks).toHaveLength(1);
    expect(outcome.hooks[0].token).toBe(TOKEN);
  });

  it('polls instead when the awaiting workflow is not the parent', async () => {
    const code = workflowCode(
      `return await ${awaitChild('wrun_someone_else')};`
    );
    const events: Event[] = [];
    const outcome = suspended(await replay(code, events));
    expect(outcome.hooks).toHaveLength(0);
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0].args).toEqual([true]);
    events.push(
      ...(await stepCompleted(outcome.steps[0], { done: true, value: 7 }))
    );
    expect(await replay(code, events)).toEqual({ done: true, value: 7 });
  });

  it('polls instead when another run holds the token', async () => {
    const code = workflowCode(`return await ${awaitChild()};`);
    const events: Event[] = [];
    let outcome = suspended(await replay(code, events));
    events.push(hookConflict(outcome.hooks[0]));

    outcome = suspended(await replay(code, events));
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0].args).toEqual([true]);
    events.push(
      ...(await stepCompleted(outcome.steps[0], { done: true, value: 'p' }))
    );
    expect(await replay(code, events)).toEqual({ done: true, value: 'p' });
  });
});

describe('awaitChildRunCompletion in the QuickJS VM', () => {
  const quickJSCode = `${helperSource}
globalThis.__private_workflows = new Map();
async function workflow() {
  return await ${awaitChild()};
}
workflow.workflowId = "workflow//test//workflow";
globalThis.__private_workflows.set("workflow//test//workflow", workflow);`;

  const run = {
    runId: PARENT_RUN_ID,
    deploymentId: 'dpl_test',
    workflowName: 'workflow//test//workflow',
    input: undefined,
    status: 'running' as const,
    output: undefined,
    error: undefined,
    completedAt: undefined,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    specVersion: 2,
  };
  const runCreated = {
    eventId: 'evnt_run_created',
    runId: PARENT_RUN_ID,
    eventType: 'run_created' as const,
    eventData: { input: serialize([]) },
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };

  it('registers the completion hook before reading the child', async () => {
    const first = await runQuickJSWorkflow({
      workflowCode: quickJSCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const ops = first.suspended?.pendingOperations ?? [];
    expect(ops.filter((op) => op.type === 'step')).toHaveLength(0);
    const hook = ops.find((op) => op.type === 'hook');
    expect(hook).toMatchObject({ type: 'hook', token: TOKEN });
    assert(hook);

    const second = await runQuickJSWorkflow({
      workflowCode: quickJSCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreated,
        {
          eventId: 'evnt_hook_created',
          runId: PARENT_RUN_ID,
          eventType: 'hook_created',
          correlationId: hook.correlationId,
          eventData: { token: TOKEN },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
      ] as Event[],
    });
    const steps = (second.suspended?.pendingOperations ?? []).filter(
      (op) => op.type === 'step'
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepId: READ_STEP });
  });
});
