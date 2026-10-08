import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import type { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

const noEncryptionKey = undefined;

const transform = (workflowName: string) =>
  `;globalThis.__private_workflows = new Map();
   globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

const PRELUDE = `
  const doWork = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("doWork");
  const finish = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("finish");
  const afterBind = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("afterBind");
  const afterPayload = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("afterPayload");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  // Either registration outcome continues the branch: a rejection here is
  // the bare harness VM having no \`Run\` class to resolve a conflict with.
  const bind = (token) => {
    const hook = createHook({ token });
    return {
      hook,
      bound: hook.getConflict().then(
        (conflict) => conflict === null,
        () => false
      ),
    };
  };`;

/**
 * Two concurrent branches, each woken by its own step result. Branch A binds
 * a hook and awaits its registration; branch B draws a step. In the execution
 * that writes the log, both results land in the same replay pass, the
 * `getConflict()` awaiter suspends that pass, and the suspension commits
 * `hook_created` together with B's `step_created`. A's continuation can only
 * draw AFTER that suspension, so B's step takes the earlier ordinal.
 *
 * A fresh replay holds `hook_created` already, and consumes it as soon as A's
 * cascade has registered the hook, which is while B's result is still gated
 * behind A's delivery barrier. Settling the awaiter there lets A's
 * continuation draw B's ordinal, and B's committed `step_created` then names
 * a step the replay bound to `afterBind`.
 */
const SIBLING_CODE = `${PRELUDE}
  async function workflow() {
    const a = doWork('a');
    const b = doWork('b');
    const branchA = a.then(async (result) => {
      const { bound } = bind('bind');
      return afterBind(result, await bound);
    });
    const branchB = b.then((result) => finish(result));
    return await Promise.all([branchA, branchB]);
  }${transform('workflow')}`;

/** Two branches each binding a hook in the same burst: two registration
 *  barriers at distinct indices. */
const TWO_BINDS_CODE = `${PRELUDE}
  async function workflow() {
    const a = doWork('a');
    const b = doWork('b');
    const branchA = a.then(async (result) => afterBind(result, await bind('bind-a').bound));
    const branchB = b.then(async (result) => finish(result, await bind('bind-b').bound));
    return await Promise.all([branchA, branchB]);
  }${transform('workflow')}`;

/** Registration, then a payload on the same hook, with a sibling branch
 *  drawing in the same burst: the post-registration step must draw after the
 *  sibling, and the post-payload step after both. */
const PAYLOAD_CODE = `${PRELUDE}
  async function workflow() {
    const a = doWork('a');
    const b = doWork('b');
    const branchA = a.then(async (result) => {
      const { hook, bound } = bind('bind');
      const marker = await afterBind(result, await bound);
      for await (const p of hook) return await afterPayload(marker, p);
    });
    const branchB = b.then((result) => finish(result));
    return await Promise.all([branchA, branchB]);
  }${transform('workflow')}`;

/** A buffered payload on hook A that nothing has claimed sits earlier in the
 *  log than hook B's registration. B's armed barrier gates on that unarmed
 *  payload, and the only code that can claim the payload sits behind B's
 *  registration: a circular wait only the idle safety net can break. */
const PARKED_CODE = `${PRELUDE}
  async function workflow() {
    const a = createHook({ token: 'A' });
    await a.getConflict();
    const b = createHook({ token: 'B' });
    await b.getConflict();
    const payload = await a;
    return await finish(payload);
  }${transform('workflow')}`;

/** Registration in the same burst as a step whose result is later in the log:
 *  the registration must not defer behind it. */
const LATER_STEP_CODE = `${PRELUDE}
  async function workflow() {
    await doWork('a');
    const { bound } = bind('bind');
    const x = doWork('x');
    const branchA = bound.then((ok) => afterBind(ok));
    const branchX = x.then((result) => finish(result));
    return await Promise.all([branchA, branchX]);
  }${transform('workflow')}`;

/** A hook nobody awaits the registration of: the barrier is registered
 *  unconditionally and must release on its own. */
const NO_AWAITER_CODE = `${PRELUDE}
  async function workflow() {
    createHook({ token: 'unread' });
    const r = await doWork('a');
    return await finish(r);
  }${transform('workflow')}`;

const RUN_ID = 'wrun_123';

async function makeRun(): Promise<WorkflowRun> {
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], RUN_ID, noEncryptionKey, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

function eventFactory() {
  let seq = 0;
  return (partial: Omit<Event, 'eventId' | 'runId' | 'createdAt'>): Event => {
    seq += 1;
    return {
      eventId: `evnt_${String(seq).padStart(4, '0')}`,
      runId: RUN_ID,
      createdAt: new Date(2024, 0, 1, 0, 0, seq),
      ...partial,
    } as Event;
  };
}

type Ev = ReturnType<typeof eventFactory>;
type Item = WorkflowSuspension['items'][number];
type Registration = 'hook_created' | 'hook_conflict' | 'hook_conflict_no_run';

function created(ev: Ev, step: Item): Event {
  assert(step.type === 'step');
  return ev({
    eventType: 'step_created',
    correlationId: step.correlationId,
    eventData: { stepName: step.stepName },
  });
}

async function completed(ev: Ev, step: Item, value: unknown): Promise<Event[]> {
  assert(step.type === 'step');
  return [
    ev({
      eventType: 'step_started',
      correlationId: step.correlationId,
      eventData: { stepName: step.stepName },
    }),
    ev({
      eventType: 'step_completed',
      correlationId: step.correlationId,
      eventData: {
        stepName: step.stepName,
        result: await dehydrateStepReturnValue(
          value,
          RUN_ID,
          noEncryptionKey,
          []
        ),
      },
    }),
  ];
}

function registration(ev: Ev, hook: Item, outcome: Registration): Event {
  assert(hook.type === 'hook');
  if (outcome === 'hook_created') {
    return ev({
      eventType: 'hook_created',
      correlationId: hook.correlationId,
      eventData: { token: hook.token },
    });
  }
  return ev({
    eventType: 'hook_conflict',
    correlationId: hook.correlationId,
    eventData: {
      token: hook.token,
      ...(outcome === 'hook_conflict'
        ? { conflictingRunId: 'wrun_other' }
        : {}),
    },
  });
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

async function replayOrThrow(code: string, run: WorkflowRun, events: Event[]) {
  try {
    return await suspend(code, run, events);
  } catch (err) {
    throw new Error(`fresh replay diverged: ${(err as Error).message}`);
  }
}

const describeItem = (item: Item) =>
  item.type === 'step'
    ? `${item.correlationId}:${item.stepName}`
    : `${item.correlationId}:${item.type}`;

const stepNamed = (s: WorkflowSuspension, name: string) => {
  const item = s.items.find((i) => i.type === 'step' && i.stepName === name);
  assert(
    item?.type === 'step',
    `expected a ${name} step, drew ${s.items.map(describeItem).join(', ')}`
  );
  return item;
};
const hooksOf = (s: WorkflowSuspension) =>
  s.items.filter((i): i is Item & { type: 'hook' } => i.type === 'hook');

/**
 * Drives the sibling shape through the writer's passes and returns the log the
 * writer committed plus what it drew in the pass that bound the hook.
 */
async function writeSiblingLog(run: WorkflowRun, outcome: Registration) {
  const ev = eventFactory();
  const pass1 = await suspend(SIBLING_CODE, run, []);
  const [a, b] = pass1.items;
  assert(a?.type === 'step' && b?.type === 'step');
  const log: Event[] = [created(ev, a), created(ev, b)];
  for (const step of [a, b]) {
    log.push(...(await completed(ev, step, `r-${step.correlationId}`)));
  }
  const pass2 = await suspend(SIBLING_CODE, run, log);
  const [hook] = hooksOf(pass2);
  const finish = stepNamed(pass2, 'finish');
  assert(hook);
  expect(hook.hasConflictAwaiter).toBe(true);
  expect(pass2.items.map(describeItem)).toEqual([
    describeItem(hook),
    describeItem(finish),
  ]);
  // Committed the way the runtime commits a suspension: the hook's own write
  // first, then the batch of step creates.
  log.push(registration(ev, hook, outcome), created(ev, finish));
  return { log, finish, hook, ev };
}

describe('hook registration delivery order', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { outcome: 'hook_created' as const },
    { outcome: 'hook_conflict' as const },
    // No `conflictingRunId`: the awaiter rejects instead of resolving with a
    // Run, through the same deferred settlement.
    { outcome: 'hook_conflict_no_run' as const },
  ])('settles getConflict() after the sibling branch drew, as the writing execution did ($outcome)', async ({
    outcome,
  }) => {
    const run = await makeRun();
    const { log, finish } = await writeSiblingLog(run, outcome);

    // A's continuation must draw `afterBind` at the ordinal AFTER `finish`,
    // never at `finish`'s.
    const pass3 = await replayOrThrow(SIBLING_CODE, run, log);
    expect(pass3.items.map(describeItem)).toContain(describeItem(finish));
    const afterBind = stepNamed(pass3, 'afterBind');
    expect(afterBind.correlationId > finish.correlationId).toBe(true);
  });

  it('holds with WORKFLOW_LOG_ORDER_DRAWS=0 (single macrotask yield instead of the quiescence fixpoint)', async () => {
    vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', '0');
    const run = await makeRun();
    const { log, finish } = await writeSiblingLog(run, 'hook_created');
    const pass3 = await replayOrThrow(SIBLING_CODE, run, log);
    const afterBind = stepNamed(pass3, 'afterBind');
    expect(afterBind.correlationId > finish.correlationId).toBe(true);
  });

  it('is stable across repeated replays with two hooks bound in one burst', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const pass1 = await suspend(TWO_BINDS_CODE, run, []);
    const [a, b] = pass1.items;
    assert(a?.type === 'step' && b?.type === 'step');
    const log: Event[] = [created(ev, a), created(ev, b)];
    for (const step of [a, b]) {
      log.push(...(await completed(ev, step, `r-${step.correlationId}`)));
    }
    const pass2 = await suspend(TWO_BINDS_CODE, run, log);
    const [hookA, hookB] = hooksOf(pass2);
    assert(hookA && hookB);
    expect(pass2.items.filter((i) => i.type === 'step')).toEqual([]);
    log.push(
      registration(ev, hookA, 'hook_created'),
      registration(ev, hookB, 'hook_created')
    );

    // The writer's continuation draws afterBind (A woke first) then finish.
    const pass3 = await replayOrThrow(TWO_BINDS_CODE, run, log);
    const drawn = pass3.items.map(describeItem);
    const afterBind = stepNamed(pass3, 'afterBind');
    const finish = stepNamed(pass3, 'finish');
    expect(afterBind.correlationId < finish.correlationId).toBe(true);
    log.push(created(ev, afterBind), created(ev, finish));
    for (let i = 0; i < 5; i += 1) {
      const again = await replayOrThrow(TWO_BINDS_CODE, run, log);
      expect(again.items.map(describeItem)).toEqual(drawn);
    }
  });

  it('delivers a hook payload after the same hook’s registration', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const pass1 = await suspend(PAYLOAD_CODE, run, []);
    const [a, b] = pass1.items;
    assert(a?.type === 'step' && b?.type === 'step');
    const log: Event[] = [created(ev, a), created(ev, b)];
    for (const step of [a, b]) {
      log.push(...(await completed(ev, step, `r-${step.correlationId}`)));
    }
    const pass2 = await suspend(PAYLOAD_CODE, run, log);
    const [hook] = hooksOf(pass2);
    const finish = stepNamed(pass2, 'finish');
    assert(hook);
    log.push(registration(ev, hook, 'hook_created'), created(ev, finish));
    // Writer's continuation: afterBind drawn after the sibling, then the
    // payload arrives.
    const pass3 = await replayOrThrow(PAYLOAD_CODE, run, log);
    const afterBind = stepNamed(pass3, 'afterBind');
    expect(afterBind.correlationId > finish.correlationId).toBe(true);
    log.push(
      created(ev, afterBind),
      ...(await completed(ev, afterBind, 'marker')),
      ev({
        eventType: 'hook_received',
        correlationId: hook.correlationId,
        eventData: {
          token: hook.token,
          payload: await dehydrateStepReturnValue(
            { ok: true },
            RUN_ID,
            noEncryptionKey,
            []
          ),
        },
      })
    );
    const pass4 = await replayOrThrow(PAYLOAD_CODE, run, log);
    const afterPayload = stepNamed(pass4, 'afterPayload');
    expect(afterPayload.correlationId > afterBind.correlationId).toBe(true);
  });

  it('releases a registration parked behind an unclaimed buffered payload', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const pass1 = await suspend(PARKED_CODE, run, []);
    const [hookA] = hooksOf(pass1);
    assert(hookA);
    const log: Event[] = [registration(ev, hookA, 'hook_created')];
    const pass2 = await suspend(PARKED_CODE, run, log);
    const hookB = hooksOf(pass2).find(
      (h) => h.correlationId !== hookA.correlationId
    );
    assert(hookB);
    // The payload lands before B's registration and nothing claims it until
    // B's awaiter settles.
    log.push(
      ev({
        eventType: 'hook_received',
        correlationId: hookA.correlationId,
        eventData: {
          token: hookA.token,
          payload: await dehydrateStepReturnValue(
            'p',
            RUN_ID,
            noEncryptionKey,
            []
          ),
        },
      }),
      registration(ev, hookB, 'hook_created')
    );
    const started = Date.now();
    const pass3 = await replayOrThrow(PARKED_CODE, run, log);
    stepNamed(pass3, 'finish');
    // Released by the ordinary barrier order, not by waiting out a timer.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not defer the registration behind a later-in-log step result', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const pass1 = await suspend(LATER_STEP_CODE, run, []);
    const [a] = pass1.items;
    assert(a?.type === 'step');
    const log: Event[] = [created(ev, a), ...(await completed(ev, a, 'r-a'))];
    const pass2 = await suspend(LATER_STEP_CODE, run, log);
    const [hook] = hooksOf(pass2);
    const x = stepNamed(pass2, 'doWork');
    assert(hook);
    log.push(registration(ev, hook, 'hook_created'), created(ev, x));
    // Writer: the registration lands, afterBind is drawn; only later does x
    // complete and finish get drawn.
    const pass3 = await replayOrThrow(LATER_STEP_CODE, run, log);
    const afterBind = stepNamed(pass3, 'afterBind');
    log.push(created(ev, afterBind), ...(await completed(ev, x, 'r-x')));
    const pass4 = await replayOrThrow(LATER_STEP_CODE, run, log);
    const finish = stepNamed(pass4, 'finish');
    expect(pass4.items.map(describeItem)).toContain(describeItem(afterBind));
    expect(finish.correlationId > afterBind.correlationId).toBe(true);
  });

  it('runs to completion when nothing awaits the registration', async () => {
    const run = await makeRun();
    const ev = eventFactory();
    const pass1 = await suspend(NO_AWAITER_CODE, run, []);
    const [hook] = hooksOf(pass1);
    const a = stepNamed(pass1, 'doWork');
    assert(hook);
    const log: Event[] = [
      registration(ev, hook, 'hook_created'),
      created(ev, a),
      ...(await completed(ev, a, 'r-a')),
    ];
    const pass2 = await replayOrThrow(NO_AWAITER_CODE, run, log);
    const finish = stepNamed(pass2, 'finish');
    log.push(created(ev, finish), ...(await completed(ev, finish, 'done')));
    const result = await runWorkflow(
      NO_AWAITER_CODE,
      run,
      log,
      noEncryptionKey
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(
      await hydrateWorkflowReturnValue(result, RUN_ID, noEncryptionKey)
    ).toBe('done');
  });
});
