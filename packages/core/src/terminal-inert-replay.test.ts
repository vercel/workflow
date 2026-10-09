import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { runQuickJSWorkflow } from './runtime/quickjs-runtime.js';
import {
  deserialize,
  serialize as serializeForQuickJS,
} from './serialization/workflow-vm.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

/**
 * Terminal-inert, end to end and on both engines: once an entity's terminal
 * event (a step outcome, `wait_completed`, `hook_disposed`) is in the log,
 * every later event under its correlation id is inert, whatever its class.
 *
 * The logs here are what concurrent writers leave behind. A step invocation
 * that stalled past its queue lease writes a `step_started` or `step_retrying`
 * after another invocation recorded the step's outcome, and a `hook_received`
 * can commit behind the hook's `hook_disposed`. Each scenario replays one
 * log through the node:vm engine and the QuickJS engine and requires the
 * same outcome from both, and the same outcome as the log without the
 * stragglers.
 *
 * The workflows only return values the log decides, never `Date.now()`: the
 * QuickJS engine advances its clock on every event it reads, the node:vm
 * engine only on deliveries, which is a known difference unrelated to this
 * rule.
 */

const RUN_ID = 'wrun_terminal_inert';
const T0 = Date.UTC(2025, 0, 1);
const noEncryptionKey = undefined;

type Engine = 'node:vm' | 'quickjs';
const ENGINES: readonly Engine[] = ['node:vm', 'quickjs'];

type Outcome =
  | { type: 'completed'; value: unknown }
  | { type: 'suspended'; pending: string[] }
  | { type: 'failed'; message: string };

async function workflowRun(): Promise<WorkflowRun> {
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], RUN_ID, noEncryptionKey, []),
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    startedAt: new Date(T0),
    deploymentId: 'dpl_test',
    specVersion: 2,
  } as WorkflowRun;
}

/** `body` is the workflow function's body; both engines expose the same symbols. */
function nodeVmCode(body: string): string {
  return `async function workflow() { ${body} }
    globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`;
}

function quickJsCode(body: string): string {
  return `async function workflow() { ${body} }
    workflow.workflowId = "workflow";
    globalThis.__private_workflows.set("workflow", workflow);`;
}

async function replay(
  engine: Engine,
  body: string,
  events: Event[]
): Promise<Outcome> {
  const run = await workflowRun();
  if (engine === 'node:vm') {
    try {
      const output = await runWorkflow(
        nodeVmCode(body),
        run,
        events,
        noEncryptionKey
      );
      return {
        type: 'completed',
        value: await hydrateWorkflowReturnValue(
          output as never,
          RUN_ID,
          noEncryptionKey,
          []
        ),
      };
    } catch (error) {
      const err = error as Error & { items?: { correlationId: string }[] };
      if (err.name === 'WorkflowSuspension') {
        return {
          type: 'suspended',
          pending: (err.items ?? []).map((item) => item.correlationId).sort(),
        };
      }
      return { type: 'failed', message: err.message };
    }
  }
  const result = await runQuickJSWorkflow({
    workflowCode: quickJsCode(body),
    workflowId: 'workflow',
    workflowRun: run,
    events: [
      {
        eventId: 'evnt_run_created',
        runId: RUN_ID,
        eventType: 'run_created',
        eventData: { input: serializeForQuickJS([]) },
        createdAt: new Date(T0),
      } as unknown as Event,
      ...events,
    ],
  });
  if (result.completed) {
    return { type: 'completed', value: deserialize(result.completed.result) };
  }
  if (result.suspended) {
    return {
      type: 'suspended',
      pending: result.suspended.pendingOperations
        .filter((op) => !op.hasCreatedEvent)
        .map((op) => op.correlationId)
        .sort(),
    };
  }
  return { type: 'failed', message: JSON.stringify(result) };
}

/** Correlation ids the workflow draws, in order, read off a first run. */
async function correlationIds(
  engine: Engine,
  body: string,
  events: Event[] = []
): Promise<string[]> {
  const outcome = await replay(engine, body, events);
  if (outcome.type !== 'suspended') {
    throw new Error(`expected a suspension, got ${JSON.stringify(outcome)}`);
  }
  return outcome.pending;
}

class Log {
  readonly events: Event[] = [];

  add(
    eventType: string,
    correlationId: string,
    eventData: Record<string, unknown> = {}
  ): this {
    const index = this.events.length + 1;
    this.events.push({
      eventId: `evnt_${String(index).padStart(26, '0')}`,
      runId: RUN_ID,
      eventType,
      correlationId,
      eventData,
      createdAt: new Date(T0 + index * 1000),
    } as unknown as Event);
    return this;
  }
}

const stepResult = (value: unknown) =>
  dehydrateStepReturnValue(value, RUN_ID, noEncryptionKey, []);

const STEP_BODY = `
  const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
  const double = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("double");
  const a = await add(1, 2);
  const b = await double(a);
  return [a, b];`;

/**
 * The log of `STEP_BODY` with `stragglers` written after `add`'s outcome and
 * before `double` is created, which is where a stalled invocation's writes
 * land relative to the run that moved on without it.
 */
async function stepLog(
  engine: Engine,
  addEvents: (log: Log, add: string) => Promise<void> | void,
  stragglers: (log: Log, add: string) => void
): Promise<Event[]> {
  const [add] = await correlationIds(engine, STEP_BODY);
  const log = new Log();
  await addEvents(log, add);
  stragglers(log, add);
  const [double] = (await correlationIds(engine, STEP_BODY, log.events)).filter(
    (id) => id !== add
  );
  log
    .add('step_created', double, { stepName: 'double' })
    .add('step_started', double, { stepName: 'double' })
    .add('step_completed', double, { result: await stepResult(6) });
  return log.events;
}

/**
 * Appends the outcome of the step the body is waiting on once it has read
 * `log`: the body has to read past everything already in the log to reach
 * it, which is what makes a straggler in the middle of the log matter.
 */
async function completeNextStep(
  engine: Engine,
  body: string,
  log: Log,
  value: unknown
): Promise<void> {
  const known = new Set(log.events.map((event) => event.correlationId));
  const [next] = (await correlationIds(engine, body, log.events)).filter(
    (id) => !known.has(id)
  );
  log
    .add('step_created', next, { stepName: 'double' })
    .add('step_started', next, { stepName: 'double' })
    .add('step_completed', next, { result: await stepResult(value) });
}

async function addCompletes(log: Log, add: string) {
  log
    .add('step_created', add, { stepName: 'add' })
    .add('step_started', add, { stepName: 'add' })
    .add('step_completed', add, { result: await stepResult(3) });
}

describe('terminal-inert replay', () => {
  describe.each(ENGINES)('%s', (engine) => {
    it('reads past a start and a retry written after the step completed', async () => {
      const events = await stepLog(engine, addCompletes, (log, add) => {
        // A redelivered invocation whose body failed after the winner's
        // outcome: a `step_retrying` that repeats no earlier retry.
        log
          .add('step_started', add, { stepName: 'add' })
          .add('step_retrying', add, { stepName: 'add' })
          .add('step_started', add, { stepName: 'add' });
      });

      expect(await replay(engine, STEP_BODY, events)).toEqual({
        type: 'completed',
        value: [3, 6],
      });
    });

    it('reads past a start written after the step failed', async () => {
      const body = `
        const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
        const double = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("double");
        let caught = "no";
        try { await add(1, 2); } catch (e) { caught = "caught"; }
        return [caught, await double(2)];`;
      const [add] = await correlationIds(engine, body);
      const log = new Log()
        .add('step_created', add, { stepName: 'add' })
        .add('step_failed', add, {
          stepName: 'add',
          error: { message: 'boom', stack: '' },
        })
        // No `step_started` precedes the outcome, so this one repeats nothing.
        .add('step_started', add, { stepName: 'add' });
      await completeNextStep(engine, body, log, 4);

      expect(await replay(engine, body, log.events)).toEqual({
        type: 'completed',
        value: ['caught', 4],
      });
    });

    it('replays a retried step exactly as before', async () => {
      // Every attempt's events precede the outcome, so the step's consumer is
      // still open for each of them and takes it as an attempt.
      const events = await stepLog(
        engine,
        async (log, add) => {
          log
            .add('step_created', add, { stepName: 'add' })
            .add('step_started', add, { stepName: 'add' })
            .add('step_retrying', add, { stepName: 'add' })
            .add('step_started', add, { stepName: 'add' })
            .add('step_completed', add, { result: await stepResult(3) });
        },
        () => {}
      );

      expect(await replay(engine, STEP_BODY, events)).toEqual({
        type: 'completed',
        value: [3, 6],
      });
    });

    it('does not let a closed step hide an event for another entity', async () => {
      const [add] = await correlationIds(engine, STEP_BODY);
      const log = new Log();
      await addCompletes(log, add);
      const [double] = (
        await correlationIds(engine, STEP_BODY, log.events)
      ).filter((id) => id !== add);
      // A wait the body never creates, after `add` closed. It is not under
      // `add`'s correlation id, so closing `add` must not cover it.
      log.add('wait_created', 'wait_01JZZZZZZZZZZZZZZZZZZZZZZZ', {
        resumeAt: new Date(T0 + 3_600_000),
      });

      const outcome = await replay(engine, STEP_BODY, log.events);
      if (engine === 'node:vm') {
        expect(outcome).toMatchObject({ type: 'failed' });
        expect((outcome as { message: string }).message).toContain(
          'Replay could not consume event: eventType=wait_created'
        );
      } else {
        // The QuickJS engine has no divergence detection and reads past an
        // event nobody created. Pinned so a change on either side is seen.
        expect(outcome).toEqual({ type: 'suspended', pending: [double] });
      }
    });

    it('reads past a payload committed behind the hook disposal', async () => {
      const body = `
        const hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({ token: "tok" });
        const double = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("double");
        const first = await hook;
        hook.dispose();
        return [first, await double(1)];`;
      const [hook] = await correlationIds(engine, body);
      const payload = async (value: unknown) => ({
        token: 'tok',
        payload: await stepResult(value),
      });
      const log = new Log()
        .add('hook_created', hook, { token: 'tok', isWebhook: false })
        .add('hook_received', hook, await payload('first'))
        .add('hook_disposed', hook, { token: 'tok' })
        .add('hook_received', hook, await payload('second'));
      await completeNextStep(engine, body, log, 2);

      expect(await replay(engine, body, log.events)).toEqual({
        type: 'completed',
        value: ['first', 2],
      });
    });

    it('reads past a wait event written after the wait completed', async () => {
      const body = `
        const double = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("double");
        await globalThis[Symbol.for("WORKFLOW_SLEEP")]("10s");
        return ["woke", await double(1)];`;
      const [wait] = await correlationIds(engine, body);
      const resumeAt = new Date(T0 + 10_000);
      const log = new Log()
        .add('wait_created', wait, { resumeAt })
        .add('wait_completed', wait)
        // A replay that read the log before the completion re-creates the wait.
        .add('wait_created', wait, { resumeAt });
      await completeNextStep(engine, body, log, 2);

      expect(await replay(engine, body, log.events)).toEqual({
        type: 'completed',
        value: ['woke', 2],
      });
    });
  });
});
