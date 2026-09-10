import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

/**
 * Offline regression coverage for `WORKFLOW_LOG_ORDER_DRAWS=1`: correlation-id
 * draw order pinned to event-log order, so draw bindings are stable under
 * dense-prefix extension and concurrent replays of different-length prefixes
 * mint compatible ids.
 *
 * The shape is the 2026-08-20 production corruption (five runs on
 * 5.0.0-beta.43): a fan-out where each branch launches a step, then races a
 * hook against a watchdog sleep. A replay whose dense prefix ends just before
 * a sibling branch's launch completion sees that branch parked at its `await`
 * minting nothing, so the woken branch's finalize takes the ordinal a fresher
 * replay gives the sibling's wait. With draws pinned to log order, the
 * finalize is minted inside the cascade of the delivery that enabled it, and
 * extending the log can only append draws, never renumber them.
 */

const RUN_ID = 'wrun_log_order_draws';

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
    return suspension.items.map((item) => ({
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

function suspensionBindings(
  items: { type: string; correlationId: string; stepName?: string }[]
) {
  return items
    .map((item) => `${item.correlationId}=${item.type}:${item.stepName ?? ''}`)
    .sort();
}

describe('arrival-order draws (opt-out, WORKFLOW_LOG_ORDER_DRAWS=0)', () => {
  const original = process.env.WORKFLOW_LOG_ORDER_DRAWS;

  beforeEach(() => {
    process.env.WORKFLOW_LOG_ORDER_DRAWS = '0';
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WORKFLOW_LOG_ORDER_DRAWS;
    } else {
      process.env.WORKFLOW_LOG_ORDER_DRAWS = original;
    }
  });

  // Deliberate CONTROL: asserts the arrival-order BUG still reproduces with
  // the flag off. If this stops failing-to-bind (i.e. `rebound` comes back
  // empty), the control is obsolete, not broken — most likely because
  // positional rebinding was fixed independently of draw scheduling, e.g.
  // call-site-addressed correlation ids (vercel/workflow#3179) landing, which
  // removes the rebinding in BOTH modes. Delete this block then; do not chase
  // it as a regression.
  it('rebinds an ordinal from a step to a wait under extension (the control)', async () => {
    const { shorter, longer } = await blockedBranchPrefixes();
    const stale = await blockedBranchEntities(shorter);
    const fresh = await blockedBranchEntities(longer);
    const staleFinalizes = stale
      .filter((item) => item.stepName === 'finalizeTask')
      .map((item) => item.correlationId);
    const freshIds = new Set(fresh.map((item) => item.correlationId));
    const rebound = staleFinalizes.filter((id) => !freshIds.has(id));
    expect(rebound.length).toBeGreaterThan(0);
  });
});

describe('log-order draws (the default)', () => {
  const original = process.env.WORKFLOW_LOG_ORDER_DRAWS;

  beforeEach(() => {
    delete process.env.WORKFLOW_LOG_ORDER_DRAWS;
  });

  afterEach(() => {
    if (original !== undefined) {
      process.env.WORKFLOW_LOG_ORDER_DRAWS = original;
    }
  });

  it('keeps every binding of the shorter prefix under extension', async () => {
    const { shorter, longer } = await blockedBranchPrefixes();
    const stale = await blockedBranchEntities(shorter);
    const fresh = await blockedBranchEntities(longer);
    // Every entity the shorter replay would create must exist, under the SAME
    // correlation id and kind, in the longer replay: extension appends draws,
    // never renumbers them.
    // The corruption signature is one correlation id bound to two different
    // entities across the two replays. Compare bindings on shared ids: an id
    // present in both pending sets must name the same entity. Ids only in the
    // shorter set are entities the extension consumed (the sibling's launch);
    // ids only in the longer set are the extension's appended draws.
    const byId = (
      items: { type: string; correlationId: string; stepName?: string }[]
    ) =>
      new Map(
        items.map((item) => [
          item.correlationId,
          `${item.type}:${item.stepName ?? ''}`,
        ])
      );
    const staleById = byId(stale);
    const freshById = byId(fresh);
    const rebound: string[] = [];
    for (const [id, binding] of staleById) {
      const extended = freshById.get(id);
      if (extended !== undefined && extended !== binding) {
        rebound.push(`${id}: ${binding} -> ${extended}`);
      }
    }
    expect(rebound).toEqual([]);
    // And specifically: the woken branches' finalize steps keep their ids.
    const staleFinalizes = stale
      .filter((item) => item.stepName === 'finalizeTask')
      .map((item) => item.correlationId)
      .sort();
    const freshFinalizes = fresh
      .filter((item) => item.stepName === 'finalizeTask')
      .map((item) => item.correlationId)
      .sort();
    expect(freshFinalizes).toEqual(staleFinalizes);
  });

  it('is stable across every dense prefix of the log', async () => {
    // The pairwise test above targets the production window; this sweeps all
    // of them: no shared correlation id may change entity between any two
    // consecutive dense prefixes.
    const { longer } = await blockedBranchPrefixes();
    let previous: Map<string, string> | undefined;
    for (let length = 1; length <= longer.length; length++) {
      const entities = await blockedBranchEntities(longer.slice(0, length));
      const current = new Map(
        entities.map((item) => [
          item.correlationId,
          `${item.type}:${item.stepName ?? ''}`,
        ])
      );
      if (previous) {
        for (const [id, binding] of previous) {
          const extended = current.get(id);
          expect(
            extended === undefined || extended === binding,
            `prefix ${length}: ${id} rebound ${binding} -> ${extended}`
          ).toBe(true);
        }
      }
      previous = current;
    }
  });

  it('is deterministic per prefix', async () => {
    const { longer } = await blockedBranchPrefixes();
    const a = suspensionBindings(await blockedBranchEntities(longer));
    const b = suspensionBindings(await blockedBranchEntities(longer));
    expect(b).toEqual(a);
  });
});
