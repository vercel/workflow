import type { Event, WorkflowRun } from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import type { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

const noEncryptionKey = undefined;
const transform = (n: string) =>
  `;globalThis.__private_workflows = new Map();
   globalThis.__private_workflows.set(${JSON.stringify(n)}, ${n});`;

/**
 * The wake-loop shape: a hook nobody has read yet, a heartbeat sleep, and
 * control flow that reads the clock once the heartbeat fires. The step's
 * argument records what `Date.now()` returned, so a suspension exposes it.
 */
const HEARTBEAT_CODE = `
  const probe = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("probe");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    createHook({ token: 'wake' });
    const t0 = Date.now();
    await sleep('30s');
    await probe({ afterSleepMs: Date.now() - t0 });
    return 'ok';
  }${transform('workflow')}`;

/** Two steps in flight; the clock after the first must not read the second. */
const SIBLINGS_CODE = `
  const doWork = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("doWork");
  const probe = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("probe");
  async function workflow() {
    const t0 = Date.now();
    const a = doWork('a');
    const b = doWork('b');
    await a;
    await probe({ afterAMs: Date.now() - t0 });
    await b;
    return 'ok';
  }${transform('workflow')}`;

const RUN_ID = 'wrun_123';
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

async function makeRun(): Promise<WorkflowRun> {
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], RUN_ID, noEncryptionKey, []),
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    startedAt: new Date(T0),
    deploymentId: 'test-deployment',
  };
}

function eventFactory() {
  let seq = 0;
  return (
    offsetMs: number,
    partial: Omit<Event, 'eventId' | 'runId' | 'createdAt'>
  ): Event => {
    seq += 1;
    return {
      eventId: `evnt_${String(seq).padStart(4, '0')}`,
      runId: RUN_ID,
      createdAt: new Date(T0 + offsetMs),
      ...partial,
    } as Event;
  };
}

async function suspend(code: string, run: WorkflowRun, events: Event[]) {
  try {
    await runWorkflow(code, run, events, noEncryptionKey);
  } catch (err) {
    if ((err as Error).name === 'WorkflowSuspension') {
      return err as WorkflowSuspension;
    }
    throw err;
  }
  throw new Error('expected a suspension');
}

function probeArg(s: WorkflowSuspension): Record<string, number> {
  const step = s.items.find((i) => i.type === 'step' && i.stepName === 'probe');
  assert(step?.type === 'step', 'expected the probe step to be drawn');
  return step.args[0] as Record<string, number>;
}

describe('replay clock is anchored to deliveries', () => {
  it('a later hook payload does not advance Date.now() in the heartbeat’s cascade', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const first = await suspend(HEARTBEAT_CODE, run, []);
    const hook = first.items.find((i) => i.type === 'hook');
    const wait = first.items.find((i) => i.type === 'wait');
    assert(hook?.type === 'hook' && wait?.type === 'wait');
    const log: Event[] = [
      ev(0, {
        eventType: 'hook_created',
        correlationId: hook.correlationId,
        eventData: { token: hook.token },
      }),
      ev(0, {
        eventType: 'wait_created',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      }),
      ev(30_000, {
        eventType: 'wait_completed',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      }),
    ];
    // The execution that wrote the log woke on the heartbeat with no payload
    // in the log yet.
    const writer = await suspend(HEARTBEAT_CODE, run, log);
    expect(probeArg(writer).afterSleepMs).toBe(30_000);

    // A later replay holds a payload that arrived 5s after the heartbeat and
    // that the workflow never reads. It must see the same clock.
    const later = await suspend(HEARTBEAT_CODE, run, [
      ...log,
      ev(35_000, {
        eventType: 'hook_received',
        correlationId: hook.correlationId,
        eventData: {
          token: hook.token,
          payload: await dehydrateStepReturnValue(
            { n: 1 },
            RUN_ID,
            noEncryptionKey,
            []
          ),
        },
      }),
    ]);
    expect(probeArg(later).afterSleepMs).toBe(30_000);
  });

  it('a sibling’s later result does not advance Date.now() in the earlier result’s cascade', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const first = await suspend(SIBLINGS_CODE, run, []);
    const [a, b] = first.items;
    assert(a?.type === 'step' && b?.type === 'step');
    const log: Event[] = [];
    for (const step of [a, b]) {
      log.push(
        ev(0, {
          eventType: 'step_created',
          correlationId: step.correlationId,
          eventData: { stepName: step.stepName },
        })
      );
    }
    const done = async (step: typeof a, at: number) => [
      ev(at, {
        eventType: 'step_started',
        correlationId: step.correlationId,
        eventData: { stepName: step.stepName },
      }),
      ev(at, {
        eventType: 'step_completed',
        correlationId: step.correlationId,
        eventData: {
          stepName: step.stepName,
          result: await dehydrateStepReturnValue(
            'r',
            RUN_ID,
            noEncryptionKey,
            []
          ),
        },
      }),
    ];
    // The writer saw only `a` complete.
    const writer = await suspend(SIBLINGS_CODE, run, [
      ...log,
      ...(await done(a, 2_000)),
    ]);
    expect(probeArg(writer).afterAMs).toBe(2_000);
    // A later replay also holds `b`'s completion, consumed in the same drain
    // window as `a`'s but delivered after the probe was drawn.
    const later = await suspend(SIBLINGS_CODE, run, [
      ...log,
      ...(await done(a, 2_000)),
      ...(await done(b, 9_000)),
    ]);
    expect(probeArg(later).afterAMs).toBe(2_000);
  });
});
