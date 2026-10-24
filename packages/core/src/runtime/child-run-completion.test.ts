import { readFileSync } from 'node:fs';
import type { Event, WorkflowRun } from '@workflow/world';
import ts from 'typescript';
import { assert, describe, expect, it } from 'vitest';
import type {
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
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
  childRunCompletionToken,
  safetyCheckDelayMs,
} from './child-run-completion.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

const PARENT_RUN_ID = 'wrun_parent';
const TOKEN = childRunCompletionToken(PARENT_RUN_ID);
const READ_VALUE = 'step//test//readReturnValue';
const READ_FINISHED = 'step//test//readFinishedRunIds';

// In real bundles the module is compiled into the workflow bundle (it is
// imported by the workflow-mode `Run`). It has no runtime imports, so its
// transpiled source can be evaluated in the VM as is.
const moduleSource = ts.transpileModule(
  readFileSync(new URL('./child-run-completion.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;

const helperSource = `
const __completion = (function () {
  var exports = {};
  ${moduleSource}
  return exports;
})();
const readReturnValue = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(READ_VALUE)});
const readFinished = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(READ_FINISHED)});
`;

/** `run.returnValue` for a child handle whose recorded parent is `parentRunId`. */
const awaitChild = (childRunId: string, parentRunId = PARENT_RUN_ID) =>
  `(__completion.awaitChildRunCompletion(${JSON.stringify(childRunId)}, ${JSON.stringify(parentRunId)}, () => readReturnValue(${JSON.stringify(childRunId)}), (ids) => readFinished(ids)) ?? readReturnValue(${JSON.stringify(childRunId)}))`;

function workflowCode(body: string): string {
  return `${helperSource}
async function workflow() {
  ${body}
}
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set("workflow", workflow);`;
}

const STARTED_AT = new Date('2024-01-01T00:00:00.000Z');

async function makeRun(): Promise<WorkflowRun> {
  return {
    runId: PARENT_RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], PARENT_RUN_ID, undefined, []),
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    startedAt: STARTED_AT,
    deploymentId: 'test-deployment',
  };
}

type Outcome =
  | { done: true; value: unknown }
  | {
      done: false;
      hooks: HookInvocationQueueItem[];
      steps: StepInvocationQueueItem[];
      waits: WaitInvocationQueueItem[];
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
      // Only steps still to run: the replay re-reports completed ones.
      steps: items.filter(
        (item): item is StepInvocationQueueItem =>
          item.type === 'step' && !item.hasCreatedEvent
      ),
      waits: items.filter(
        (item): item is WaitInvocationQueueItem => item.type === 'wait'
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

/** Drives one parent through its event log, appending what the runtime would. */
class Log {
  events: Event[] = [];
  #seq = 0;
  #clock = STARTED_AT.getTime();

  constructor(readonly code: string) {}

  replay() {
    return replay(this.code, this.events);
  }

  async suspend() {
    return suspended(await this.replay());
  }

  #push(fields: Record<string, unknown>, at?: number) {
    if (at === undefined) {
      this.#clock += 1_000;
      at = this.#clock;
    }
    this.events.push({
      eventId: `evnt_${String(this.#seq++).padStart(4, '0')}`,
      runId: PARENT_RUN_ID,
      createdAt: new Date(at),
      ...fields,
    } as Event);
  }

  hookCreated(hook: HookInvocationQueueItem) {
    this.#push({
      eventType: 'hook_created',
      correlationId: hook.correlationId,
      eventData: { token: hook.token, isSystem: true },
    });
  }

  hookConflict(hook: HookInvocationQueueItem) {
    this.#push({
      eventType: 'hook_conflict',
      correlationId: hook.correlationId,
      eventData: { token: hook.token, conflictingRunId: 'wrun_other' },
    });
  }

  hookDisposed(hook: HookInvocationQueueItem) {
    this.#push({
      eventType: 'hook_disposed',
      correlationId: hook.correlationId,
      eventData: {},
    });
  }

  async childFinished(hook: HookInvocationQueueItem, runId: string) {
    this.#push({
      eventType: 'hook_received',
      correlationId: hook.correlationId,
      eventData: {
        token: hook.token,
        payload: await dehydrateStepReturnValue(
          { runId, status: 'completed' },
          PARENT_RUN_ID,
          undefined,
          []
        ),
      },
    });
  }

  waitCreated(wait: WaitInvocationQueueItem) {
    this.#push({
      eventType: 'wait_created',
      correlationId: wait.correlationId,
      eventData: { resumeAt: wait.resumeAt },
    });
  }

  waitCompleted(wait: WaitInvocationQueueItem) {
    this.#push(
      {
        eventType: 'wait_completed',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      },
      wait.resumeAt.getTime()
    );
    this.#clock = wait.resumeAt.getTime();
  }

  async stepCompleted(step: StepInvocationQueueItem, result: unknown) {
    this.#push({
      eventType: 'step_started',
      correlationId: step.correlationId,
      eventData: { stepName: step.stepName },
    });
    this.#push({
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
    });
  }
}

const stepsNamed = (
  outcome: { steps: StepInvocationQueueItem[] },
  name: string
) => outcome.steps.filter((step) => step.stepName === name);

describe('awaitChildRunCompletion', () => {
  it('returns undefined outside the workflow VM', () => {
    expect(
      awaitChildRunCompletion(
        'wrun_child',
        PARENT_RUN_ID,
        async () => 1,
        async () => []
      )
    ).toBeUndefined();
  });

  it('returns undefined for a handle with no recorded parent', () => {
    expect(
      awaitChildRunCompletion(
        'wrun_child',
        undefined,
        async () => 1,
        async () => []
      )
    ).toBeUndefined();
  });

  it('registers one system hook, reads the child, parks, and reads the value once notified', async () => {
    const log = new Log(workflowCode(`return await ${awaitChild('wrun_a')};`));

    // 1. The parent's system hook is registered before anything reads.
    let s = await log.suspend();
    expect(s.steps).toHaveLength(0);
    expect(s.hooks).toHaveLength(1);
    const [hook] = s.hooks;
    expect(hook).toMatchObject({
      token: TOKEN,
      isSystem: true,
      hasConflictAwaiter: true,
    });
    log.hookCreated(hook);

    // 2. Then one batched status read.
    s = await log.suspend();
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({
      stepName: READ_FINISHED,
      args: [['wrun_a']],
    });
    await log.stepCompleted(s.steps[0], []);

    // 3. Still running: park on the hook, with the safety-net sleep open.
    s = await log.suspend();
    expect(s.steps).toHaveLength(0);
    expect(s.waits).toHaveLength(1);
    // New waits are stamped from the current time once the log is behind it.
    expect(
      Math.abs(
        s.waits[0].resumeAt.getTime() - Date.now() - safetyCheckDelayMs(0)
      )
    ).toBeLessThan(60_000);
    log.waitCreated(s.waits[0]);

    // 4. The child resumed the parent's hook: read its result.
    await log.childFinished(hook, 'wrun_a');
    s = await log.suspend();
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({
      stepName: READ_VALUE,
      args: ['wrun_a'],
    });
    await log.stepCompleted(s.steps[0], 42);

    expect(await log.replay()).toEqual({ done: true, value: 42 });
  });

  it('shares one hook and one status read across a fan-out', async () => {
    const log = new Log(
      workflowCode(`
        return await Promise.all([${awaitChild('wrun_a')}, ${awaitChild('wrun_b')}, ${awaitChild('wrun_c')}]);
      `)
    );
    let s = await log.suspend();
    expect(s.hooks).toHaveLength(1);
    const [hook] = s.hooks;
    log.hookCreated(hook);

    s = await log.suspend();
    expect(stepsNamed(s, READ_FINISHED)).toHaveLength(1);
    expect(s.steps[0].args).toEqual([['wrun_a', 'wrun_b', 'wrun_c']]);
    // `b` had already finished.
    await log.stepCompleted(s.steps[0], ['wrun_b']);

    s = await log.suspend();
    expect(s.steps.map((step) => step.args)).toEqual([['wrun_b']]);
    await log.stepCompleted(s.steps[0], 'B');
    s = await log.suspend();
    log.waitCreated(s.waits[0]);

    // Children resume the same hook, in any order.
    await log.childFinished(hook, 'wrun_c');
    s = await log.suspend();
    expect(s.steps.map((step) => step.args)).toEqual([['wrun_c']]);
    await log.stepCompleted(s.steps[0], 'C');
    await log.childFinished(hook, 'wrun_a');
    s = await log.suspend();
    expect(s.steps.map((step) => step.args)).toEqual([['wrun_a']]);
    await log.stepCompleted(s.steps[0], 'A');

    const done = await log.replay();
    expect(done).toEqual({ done: true, value: ['A', 'B', 'C'] });
    // Never more than the one hook.
    expect(
      log.events.filter((e) => e.eventType === 'hook_created')
    ).toHaveLength(1);
  });

  it('re-reads pending children when the safety-net sleep fires', async () => {
    const log = new Log(workflowCode(`return await ${awaitChild('wrun_a')};`));
    let s = await log.suspend();
    const [hook] = s.hooks;
    log.hookCreated(hook);
    s = await log.suspend();
    await log.stepCompleted(s.steps[0], []);
    s = await log.suspend();
    const [firstWait] = s.waits;
    log.waitCreated(firstWait);

    // No notification ever arrives (e.g. the child was cancelled without the
    // SDK). The safety net reads the child again and finds it finished.
    log.waitCompleted(firstWait);
    s = await log.suspend();
    expect(stepsNamed(s, READ_FINISHED).map((step) => step.args)).toEqual([
      [['wrun_a']],
    ]);
    await log.stepCompleted(s.steps[0], []);

    // Still running: the next check is further out.
    s = await log.suspend();
    const nextWait = s.waits.find(
      (wait) => wait.correlationId !== firstWait.correlationId
    );
    assert(nextWait);
    expect(
      Math.abs(
        nextWait.resumeAt.getTime() -
          firstWait.resumeAt.getTime() -
          (safetyCheckDelayMs(1) - safetyCheckDelayMs(0))
      )
    ).toBeLessThan(60_000);
    log.waitCreated(nextWait);
    log.waitCompleted(nextWait);
    s = await log.suspend();
    await log.stepCompleted(s.steps[0], ['wrun_a']);
    s = await log.suspend();
    expect(s.steps.map((step) => step.stepName)).toEqual([READ_VALUE]);
    await log.stepCompleted(s.steps[0], 'late');
    expect(await log.replay()).toEqual({ done: true, value: 'late' });
  });

  it('disposes the hook between waits and registers it again for a later await', async () => {
    const log = new Log(
      workflowCode(`
        const a = await ${awaitChild('wrun_a')};
        const b = await ${awaitChild('wrun_b')};
        return [a, b];
      `)
    );
    let s = await log.suspend();
    const [first] = s.hooks;
    log.hookCreated(first);
    s = await log.suspend();
    await log.stepCompleted(s.steps[0], ['wrun_a']);
    s = await log.suspend();
    await log.stepCompleted(s.steps[0], 'A');

    // The first wait is over: its hook is disposed and a new one registered
    // for the next child, under the same token.
    s = await log.suspend();
    const disposed = s.hooks.find(
      (hook) => hook.correlationId === first.correlationId
    );
    expect(disposed?.disposed).toBe(true);
    const second = s.hooks.find(
      (hook) => hook.correlationId !== first.correlationId
    );
    assert(second);
    expect(second).toMatchObject({ token: TOKEN, isSystem: true });
    log.hookDisposed(first);
    log.hookCreated(second);
    s = await log.suspend();
    expect(s.steps[0].args).toEqual([['wrun_b']]);
    await log.stepCompleted(s.steps[0], ['wrun_b']);
    s = await log.suspend();
    await log.stepCompleted(s.steps[0], 'B');
    expect(await log.replay()).toEqual({ done: true, value: ['A', 'B'] });
  });

  it('shares one wait between repeated awaits of the same child', async () => {
    const log = new Log(
      workflowCode(
        `return await Promise.all([${awaitChild('wrun_a')}, ${awaitChild('wrun_a')}]);`
      )
    );
    let s = await log.suspend();
    log.hookCreated(s.hooks[0]);
    s = await log.suspend();
    expect(s.steps[0].args).toEqual([['wrun_a']]);
    await log.stepCompleted(s.steps[0], ['wrun_a']);
    s = await log.suspend();
    expect(s.steps).toHaveLength(1);
    await log.stepCompleted(s.steps[0], 7);
    expect(await log.replay()).toEqual({ done: true, value: [7, 7] });
  });

  it('polls instead when the awaiting workflow is not the parent', async () => {
    const log = new Log(
      workflowCode(`return await ${awaitChild('wrun_a', 'wrun_someone_else')};`)
    );
    const s = await log.suspend();
    expect(s.hooks).toHaveLength(0);
    expect(s.steps.map((step) => step.stepName)).toEqual([READ_VALUE]);
    await log.stepCompleted(s.steps[0], 7);
    expect(await log.replay()).toEqual({ done: true, value: 7 });
  });

  it('polls instead when another run holds the token', async () => {
    const log = new Log(
      workflowCode(
        `return await Promise.all([${awaitChild('wrun_a')}, ${awaitChild('wrun_b')}]);`
      )
    );
    let s = await log.suspend();
    log.hookConflict(s.hooks[0]);
    s = await log.suspend();
    expect(s.steps.map((step) => [step.stepName, step.args])).toEqual([
      [READ_VALUE, ['wrun_a']],
      [READ_VALUE, ['wrun_b']],
    ]);
  });
});

describe('awaitChildRunCompletion in the QuickJS VM', () => {
  const quickJSCode = `${helperSource}
globalThis.__private_workflows = new Map();
async function workflow() {
  return await Promise.all([${awaitChild('wrun_a')}, ${awaitChild('wrun_b')}]);
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

  it('registers one system hook before one batched status read', async () => {
    const first = await runQuickJSWorkflow({
      workflowCode: quickJSCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const ops = first.suspended?.pendingOperations ?? [];
    expect(ops.filter((op) => op.type === 'step')).toHaveLength(0);
    const hooks = ops.filter((op) => op.type === 'hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ token: TOKEN, isSystem: true });
    const hook = hooks[0];
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
          eventData: { token: TOKEN, isSystem: true },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
      ] as Event[],
    });
    const steps = (second.suspended?.pendingOperations ?? []).filter(
      (op) => op.type === 'step'
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepId: READ_FINISHED });
  });
});
