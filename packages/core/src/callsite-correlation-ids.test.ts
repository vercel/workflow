import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

/**
 * End-to-end coverage for call-site correlation ids — the default scheme, which
 * derives correlation ids from a call site rather than from the run's global
 * entity ordinal (`WORKFLOW_CALLSITE_CORRELATION_IDS=0` opts back into the
 * positional sequence; see `correlation-id.ts`).
 *
 * The pre-existing replay fixtures elsewhere in this suite pin literal
 * correlation ids that only the positional scheme mints, so they cover the
 * default path. Here nothing is hardcoded: every id comes out of an actual
 * replay, which is the only way to assert the property that matters — that two
 * replays disagreeing about the log's prefix still address the same entity.
 */

const RUN_ID = 'wrun_callsite_ids';

async function makeRun(): Promise<WorkflowRun> {
  const ops: Promise<unknown>[] = [];
  const input = await dehydrateWorkflowArguments([], RUN_ID, undefined, ops);
  await Promise.all(ops);
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

const TRANSFORM = `;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

/**
 * A workflow that runs `finalize` a number of times decided by the event log,
 * then always calls `recover` once. Two replays that consumed a different number
 * of `finalize` completions therefore reach the same `recover` call site having
 * created a different number of entities — the shape that renames every
 * downstream entity under the positional scheme.
 */
const WORKFLOW_CODE = `
  const finalize = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("finalize");
  const recover = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("recover");
  async function workflow(finalizeCount) {
    for (let i = 0; i < finalizeCount; i++) {
      await finalize(i);
    }
    return await recover();
  }${TRANSFORM}`;

/** Replays the workflow and returns the entities its suspension asked to create. */
async function suspendedEntities(
  events: Event[],
  finalizeCount: number
): Promise<{ correlationId: string; stepName: string }[]> {
  const run = await makeRun();
  try {
    await runWorkflow(
      WORKFLOW_CODE.replace('workflow(finalizeCount)', 'workflow()').replace(
        'i < finalizeCount',
        `i < ${finalizeCount}`
      ),
      run,
      events,
      undefined
    );
  } catch (error) {
    const suspension = error as WorkflowSuspension;
    if (suspension.name !== 'WorkflowSuspension') {
      throw error;
    }
    return suspension.steps.map((step) => ({
      correlationId: step.correlationId,
      stepName: step.stepName,
    }));
  }
  throw new Error('expected the replay to suspend');
}

/** The `step_created`/`step_completed` pair a finished step leaves behind. */
async function completedStep(
  index: number,
  correlationId: string,
  stepName: string,
  returnValue: unknown
): Promise<Event[]> {
  const ops: Promise<unknown>[] = [];
  const events: Event[] = [
    {
      eventId: `event-${index}-created`,
      runId: RUN_ID,
      eventType: 'step_created',
      correlationId,
      eventData: { stepName },
      createdAt: new Date(`2024-01-01T00:00:0${index}.000Z`),
    },
    {
      eventId: `event-${index}-completed`,
      runId: RUN_ID,
      eventType: 'step_completed',
      correlationId,
      eventData: {
        stepName,
        result: await dehydrateStepReturnValue(
          returnValue,
          RUN_ID,
          undefined,
          ops
        ),
      },
      createdAt: new Date(`2024-01-01T00:00:0${index}.500Z`),
    },
  ];
  await Promise.all(ops);
  return events;
}

/** The prefix disagreement both schemes are measured against. */
async function recoverIdsForDisagreeingReplays(): Promise<[string, string]> {
  const log: Event[] = [];
  for (let i = 0; i < 3; i++) {
    const [step] = await suspendedEntities(log, 3);
    log.push(...(await completedStep(i, step!.correlationId, 'finalize', i)));
  }
  const [canonical] = await suspendedEntities(log, 3);
  const [stale] = await suspendedEntities(log.slice(0, 4), 2);
  expect(canonical?.stepName).toBe('recover');
  expect(stale?.stepName).toBe('recover');
  return [canonical!.correlationId, stale!.correlationId];
}

/**
 * The 2026-08-20 production shape (five corrupted runs on 5.0.0-beta.43): a
 * fan-out where each branch launches a step, then races a hook against a
 * watchdog sleep, and finalizes when the hook wins. A replay whose dense
 * prefix ends just before a sibling branch's launch completion sees that
 * branch parked at its `await` — the branch mints nothing, not even its
 * watchdog wait — so the woken branch's `finalizeTask` draws the ordinal a
 * fresher replay gives the sibling's wait. One correlation id then names both
 * a step and a wait, and every later replay fails with an unconsumable
 * `step_created` (CORRUPTED_EVENT_LOG).
 *
 * The two branches' pre-race hops differ on purpose: the woken branch reaches
 * its mint through the `Promise.race` resolution (two hops after delivery)
 * while the unblocked sibling mints its wait one hop after its own delivery,
 * which is how the sibling overtakes it on the shared counter.
 */
const BLOCKED_BRANCH_CODE = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const launchTask = useStep("launchTask");
  const finalizeTask = useStep("finalizeTask");
  const WATCHDOG = "watchdog";
  async function workflow() {
    await Promise.all([0, 1, 2].map(async (task) => {
      const hook = createHook({ token: "task-done-" + task });
      await launchTask(task);
      const winner = await Promise.race([
        hook,
        sleep("1h").then(() => WATCHDOG),
      ]);
      if (winner !== WATCHDOG) {
        await finalizeTask(task);
      }
    }));
  }${TRANSFORM}`;

/** Replays the blocked-branch workflow and returns every pending entity. */
async function blockedBranchEntities(
  events: Event[]
): Promise<{ type: string; correlationId: string; stepName?: string }[]> {
  const run = await makeRun();
  try {
    await runWorkflow(BLOCKED_BRANCH_CODE, run, events, undefined);
  } catch (error) {
    const suspension = error as WorkflowSuspension;
    if (suspension.name !== 'WorkflowSuspension') {
      throw error;
    }
    return suspension.steps.map((item) => ({
      type: item.type,
      correlationId: item.correlationId,
      stepName: (item as { stepName?: string }).stepName,
    }));
  }
  throw new Error('expected the replay to suspend');
}

/**
 * Builds the two dense prefixes of the production log. The shorter one ends
 * before the second branch's launch completion; the longer one appends it.
 */
async function blockedBranchPrefixes(): Promise<{
  shorter: Event[];
  longer: Event[];
}> {
  const initial = await blockedBranchEntities([]);
  const hooks = initial.filter((item) => item.type === 'hook');
  const launches = initial.filter((item) => item.stepName === 'launchTask');
  expect(hooks).toHaveLength(3);
  expect(launches).toHaveLength(3);

  let at = 0;
  const stamp = () => new Date(Date.parse('2024-01-01T00:00:00.000Z') + ++at);
  const event = (
    eventType: Event['eventType'],
    correlationId: string,
    eventData: object
  ): Event => ({
    eventId: `event-${at + 1}`,
    runId: RUN_ID,
    eventType,
    correlationId,
    eventData: eventData as Event['eventData'],
    createdAt: stamp(),
  });

  const ops: Promise<unknown>[] = [];
  const launchResult = await dehydrateStepReturnValue(
    'launched',
    RUN_ID,
    undefined,
    ops
  );
  const hookPayload = await dehydrateStepReturnValue(
    { done: true },
    RUN_ID,
    undefined,
    ops
  );
  await Promise.all(ops);

  // Mirrors the production slot order: every branch's hook and launch created,
  // the first two launches completed, both of their hooks received, and the
  // third branch's launch completion as the extension event.
  const shorter: Event[] = [
    ...hooks.map((hook, task) =>
      event('hook_created', hook.correlationId, {
        token: `task-done-${task}`,
        isWebhook: false,
      })
    ),
    ...launches.map((launch) =>
      event('step_created', launch.correlationId, { stepName: 'launchTask' })
    ),
    event('step_completed', launches[0]!.correlationId, {
      stepName: 'launchTask',
      result: launchResult,
    }),
    event('step_completed', launches[1]!.correlationId, {
      stepName: 'launchTask',
      result: launchResult,
    }),
    event('hook_received', hooks[0]!.correlationId, {
      payload: hookPayload,
    }),
    event('hook_received', hooks[1]!.correlationId, {
      payload: hookPayload,
    }),
  ];
  const longer: Event[] = [
    ...shorter,
    event('step_completed', launches[2]!.correlationId, {
      stepName: 'launchTask',
      result: launchResult,
    }),
  ];
  return { shorter, longer };
}

describe('positional correlation ids (opt-out)', () => {
  const original = process.env.WORKFLOW_CALLSITE_CORRELATION_IDS;

  beforeEach(() => {
    process.env.WORKFLOW_CALLSITE_CORRELATION_IDS = '0';
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WORKFLOW_CALLSITE_CORRELATION_IDS;
    } else {
      process.env.WORKFLOW_CALLSITE_CORRELATION_IDS = original;
    }
  });

  it('renames the next entity when two replays disagree on the prefix', async () => {
    // The control for the call-site case below: this is the corruption
    // mechanism, and it must still be reproducible on the default path.
    const [canonical, stale] = await recoverIdsForDisagreeingReplays();
    expect(stale).not.toBe(canonical);
  });

  it('rebinds a blocked branch fan-out ordinal from a step to a wait under extension', async () => {
    // The production signature, asserted as the control: the woken branch's
    // finalize takes a different id on the two prefixes, and the id it took on
    // the shorter prefix names the blocked branch's WAIT on the longer one —
    // one ordinal, two entity kinds.
    const { shorter, longer } = await blockedBranchPrefixes();
    const finalizesOf = (
      items: { stepName?: string; correlationId: string }[]
    ) =>
      items
        .filter((item) => item.stepName === 'finalizeTask')
        .map((item) => item.correlationId);
    const stale = await blockedBranchEntities(shorter);
    const fresh = await blockedBranchEntities(longer);
    const staleFinalizes = finalizesOf(stale);
    const freshFinalizes = new Set(finalizesOf(fresh));
    const rebound = staleFinalizes.filter((id) => !freshFinalizes.has(id));
    expect(rebound.length).toBeGreaterThan(0);
    const freshWaitUlids = new Set(
      fresh
        .filter((item) => item.type === 'wait')
        .map((item) => item.correlationId.split('_')[1])
    );
    const collidesWithAWait = rebound.some((id) =>
      freshWaitUlids.has(id.split('_')[1])
    );
    expect(collidesWithAWait).toBe(true);
  });
});

describe('call-site correlation ids', () => {
  const original = process.env.WORKFLOW_CALLSITE_CORRELATION_IDS;

  beforeEach(() => {
    process.env.WORKFLOW_CALLSITE_CORRELATION_IDS = '1';
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WORKFLOW_CALLSITE_CORRELATION_IDS;
    } else {
      process.env.WORKFLOW_CALLSITE_CORRELATION_IDS = original;
    }
  });

  it('replays a log written by an earlier replay of the same run', async () => {
    const [firstStep] = await suspendedEntities([], 1);
    expect(firstStep?.stepName).toBe('finalize');

    // Feed the step back as completed: the replay must regenerate the same id
    // and consume it, then ask for the next entity.
    const log = await completedStep(0, firstStep!.correlationId, 'finalize', 1);
    const [nextStep] = await suspendedEntities(log, 1);
    expect(nextStep?.stepName).toBe('recover');
  });

  it('addresses a call site identically across replays that disagree on the prefix', async () => {
    // The canonical replay ran three `finalize` steps; a concurrent replay
    // loaded a snapshot with only two. Both now reach `recover` call #1. Under
    // the positional scheme these ids differ and the stale replay's write
    // creates an entity nobody can consume; here it is the same entity, so the
    // write collides with the canonical one instead.
    const [canonical, stale] = await recoverIdsForDisagreeingReplays();
    expect(stale).toBe(canonical);
  });

  it('keeps a blocked branch fan-out addressed identically under extension', async () => {
    // Same two prefixes as the positional control above: the woken branch's
    // finalize call is one call site, so it mints one id no matter whether the
    // sibling branch's launch completion made it into the loaded prefix.
    const { shorter, longer } = await blockedBranchPrefixes();
    const finalizesOf = (
      items: { stepName?: string; correlationId: string }[]
    ) =>
      items
        .filter((item) => item.stepName === 'finalizeTask')
        .map((item) => item.correlationId)
        .sort();
    expect(finalizesOf(await blockedBranchEntities(shorter))).toEqual(
      finalizesOf(await blockedBranchEntities(longer))
    );
  });

  it('separates repeated calls to the same step by argument and ordinal', async () => {
    const log: Event[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [step] = await suspendedEntities(log, 3);
      ids.push(step!.correlationId);
      log.push(...(await completedStep(i, step!.correlationId, 'finalize', i)));
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('still renames when the disagreement is about the call site itself', async () => {
    // Not every divergence collapses: a replay that already ran `recover` once
    // legitimately addresses a second `recover` call. That case still needs the
    // precondition guard — this asserts the fix does not silently paper over it.
    const log: Event[] = [];
    for (let i = 0; i < 2; i++) {
      const [step] = await suspendedEntities(log, 2);
      log.push(...(await completedStep(i, step!.correlationId, 'finalize', i)));
    }
    const [recover] = await suspendedEntities(log, 2);
    const withRecover = [
      ...log,
      ...(await completedStep(2, recover!.correlationId, 'recover', 'done')),
    ];
    // A workflow body that loops `recover` would ask for a second one; here the
    // body returns, so the run completes rather than minting a colliding id.
    await expect(
      runWorkflow(
        WORKFLOW_CODE.replace('workflow(finalizeCount)', 'workflow()').replace(
          'i < finalizeCount',
          'i < 2'
        ),
        await makeRun(),
        withRecover,
        undefined
      )
    ).resolves.toBeDefined();
  });
});
