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

/** A buffered payload claimed later than its log position: the one path where
 *  a delivery can carry a time OLDER than the clock, which the monotonic guard
 *  absorbs; and where a sibling's later result must not leak in either. */
const CLAIM_CODE = `
  const doWork = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("doWork");
  const probe = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("probe");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const t0 = Date.now();
    const hook = createHook({ token: 'wake' });
    const a = doWork('a');
    const b = doWork('b');
    await a;
    await hook;
    await probe({ afterClaimMs: Date.now() - t0 });
    await b;
    return 'ok';
  }${transform('workflow')}`;

/** The registration outcome of a hook is a delivery: the code after
 *  `getConflict()` (or after the payload awaiter rejects on a conflict) reads
 *  the outcome's time. */
const REGISTRATION_CODE = `
  const probe = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("probe");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(mode) {
    const t0 = Date.now();
    const hook = createHook({ token: 'bind' });
    if (mode === 'created') {
      await hook.getConflict();
    } else {
      try { await hook; } catch {}
    }
    await probe({ afterRegistrationMs: Date.now() - t0 });
    return 'ok';
  }${transform('workflow')}`;

/** An abort is a delivery too: a listener reads the abort's time. */
const ABORT_CODE = `
  const probe = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("probe");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const t0 = Date.now();
    const controller = new AbortController();
    const aborted = new Promise((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(Date.now() - t0))
    );
    await sleep('1s');
    await probe({ afterAbortMs: await aborted });
    return 'ok';
  }${transform('workflow')}`;

const RUN_ID = 'wrun_123';
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

async function makeRun(args: unknown[] = []): Promise<WorkflowRun> {
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments(args, RUN_ID, noEncryptionKey, []),
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

  it('a buffered payload claimed out of log order neither rewinds the clock nor lets a later result leak in', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const first = await suspend(CLAIM_CODE, run, []);
    const hook = first.items.find((i) => i.type === 'hook');
    const [a, b] = first.items.filter((i) => i.type === 'step');
    assert(hook?.type === 'hook' && a?.type === 'step' && b?.type === 'step');
    const payload = await dehydrateStepReturnValue(
      { n: 1 },
      RUN_ID,
      noEncryptionKey,
      []
    );
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
    const log: Event[] = [
      ev(0, {
        eventType: 'hook_created',
        correlationId: hook.correlationId,
        eventData: { token: hook.token },
      }),
      ev(0, {
        eventType: 'step_created',
        correlationId: a.correlationId,
        eventData: { stepName: a.stepName },
      }),
      ev(0, {
        eventType: 'step_created',
        correlationId: b.correlationId,
        eventData: { stepName: b.stepName },
      }),
      ...(await done(a, 2_000)),
      // The payload lands at 5s, before anyone reads the hook; the claim
      // happens after `a` resolved.
      ev(5_000, {
        eventType: 'hook_received',
        correlationId: hook.correlationId,
        eventData: { token: hook.token, payload },
      }),
    ];
    const writer = await suspend(CLAIM_CODE, run, log);
    expect(probeArg(writer).afterClaimMs).toBe(5_000);
    const later = await suspend(CLAIM_CODE, run, [
      ...log,
      ...(await done(b, 9_000)),
    ]);
    expect(probeArg(later).afterClaimMs).toBe(5_000);
  });

  it.each([
    { mode: 'created', eventType: 'hook_created' as const },
    { mode: 'conflict', eventType: 'hook_conflict' as const },
  ])('a hook’s registration outcome advances the clock to its own time ($eventType)', async ({
    mode,
    eventType,
  }) => {
    const run = await makeRun([mode]);
    const ev = eventFactory();
    const first = await suspend(REGISTRATION_CODE, run, []);
    const hook = first.items.find((i) => i.type === 'hook');
    assert(hook?.type === 'hook');
    const log: Event[] = [
      ev(7_000, {
        eventType,
        correlationId: hook.correlationId,
        eventData: { token: hook.token, conflictingRunId: 'wrun_other' },
      }),
    ];
    const next = await suspend(REGISTRATION_CODE, run, log);
    expect(probeArg(next).afterRegistrationMs).toBe(7_000);
  });

  it('an abort advances the clock to its own time', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const first = await suspend(ABORT_CODE, run, []);
    const hook = first.items.find((i) => i.type === 'hook');
    const wait = first.items.find((i) => i.type === 'wait');
    assert(hook?.type === 'hook' && wait?.type === 'wait');
    const log: Event[] = [
      ev(0, {
        eventType: 'hook_created',
        correlationId: hook.correlationId,
        eventData: { token: hook.token, isWebhook: false },
      }),
      ev(0, {
        eventType: 'wait_created',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      }),
      ev(1_000, {
        eventType: 'wait_completed',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      }),
      ev(7_000, {
        eventType: 'hook_received',
        correlationId: hook.correlationId,
        eventData: {
          token: hook.token,
          payload: await dehydrateStepReturnValue(
            { reason: 'cancelled' },
            RUN_ID,
            noEncryptionKey,
            []
          ),
        },
      }),
    ];
    const next = await suspend(ABORT_CODE, run, log);
    expect(probeArg(next).afterAbortMs).toBe(7_000);
  });
});
