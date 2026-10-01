/**
 * E2E tests for dynamic workflows: runs started from workflow source rather
 * than from a workflow function in the deployment's build-time manifest.
 *
 * The workflows under test are **generated inside the deployment**, by the
 * fixtures in `workflows/99_e2e.ts` (`dynamicWorkflowFromApp` and friends).
 * That is deliberate, and it is most of the reason this is worth testing end
 * to end at all:
 *
 * - `experimental_dynamic.steps` is given the *imported* `add` step function, so the
 *   `.stepId` the build-time transform stamped on it is what binds the source
 *   to a registered step. This runner cannot do that — it holds no handle on
 *   the function — and would have to fall back to an explicit `{ stepId }`.
 * - The source is assembled at runtime by app code, which is how dynamic
 *   source reaches `start()` in an application.
 * - The deployed handler compiles, stores, reads back and evaluates the code
 *   in its own process, on every delivery.
 *
 * So each test starts a *static* fixture, which starts a *dynamic* child, and
 * then asserts on the child. Runs against every world the matrix covers —
 * Vercel, local dev/prod, and Postgres — with no per-world branching.
 *
 * The deployment must opt in with WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1;
 * without it each fixture's `start()` refuses and the test skips. A lane that
 * opts its server in also sets WORKFLOW_E2E_EXPECT_DYNAMIC_WORKFLOWS=1 on the
 * runner, and there that refusal fails the test instead.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1 pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-dynamic-workflow.test.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getCurrentTest } from '@vitest/runner';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run, start as rawStart } from '../src/runtime';
import { getHookByToken, getRun, getWorld, resumeHook } from '../src/runtime';
import {
  getCollectedRunIds,
  getWorkflowMetadata,
  isJsApp,
  requireFixture,
  setupRunTracking,
  setupWorld,
  startTracked,
  trackRun,
  writeInfraSidecar,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  return startTracked<T>(...args);
}

/** Same fixture lookup + conformance gate `e2e.test.ts` uses. */
const e2e = (fn: string) => {
  requireFixture(fn);
  return getWorkflowMetadata(deploymentUrl, 'workflows/99_e2e.ts', fn);
};

/** What the parent fixture returns: the dynamic child it started. */
interface DynamicChild {
  parentInput?: number;
  childRunId: string;
}

/**
 * Set on lanes whose server runs with WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1,
 * so a "not opted in" refusal there is a failure rather than a skip.
 */
const expectDynamicWorkflows =
  process.env.WORKFLOW_E2E_EXPECT_DYNAMIC_WORKFLOWS === '1';

/**
 * The messages `start()` throws, inside the fixture's step, when this
 * deployment cannot run dynamic workflows. They reach the runner wrapped in
 * the parent's failure.
 */
const UNSUPPORTED_DEPLOYMENT: readonly {
  pattern: RegExp;
  reason: string;
  /** Fail instead of skipping when the lane expects dynamic workflows. */
  optIn?: true;
}[] = [
  {
    // The deployment has not set WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS.
    pattern: /Dynamic workflows are disabled on this deployment/,
    reason: 'this deployment has not opted in to dynamic workflows',
    optIn: true,
  },
  {
    // The World does not declare `capabilities.dynamicWorkflowCode`.
    pattern: /Dynamic workflows require a World that declares/,
    reason: "this deployment's World does not support dynamic workflows",
  },
  {
    // The backend refused `run_created` because the project is outside its
    // dynamic-source storage rollout.
    pattern: /dynamic workflow storage is not enabled for this project/,
    reason:
      "this deployment's Workflow backend has not enabled dynamic-source storage for this project",
  },
  {
    // The backend accepted the run but did not persist its workflow code.
    pattern: /did not store its dynamic workflow code/,
    reason:
      "this deployment's Workflow backend has no dynamic-source storage yet",
  },
];

/**
 * The run id `start()` names in that error.
 *
 * The dynamic run *is* created before the check runs: `start()` writes
 * `run_created`, reads back what the backend kept, and only publishes the run
 * once its code was stored. So on this path a real dynamic run exists in the
 * world, left `pending` and never queued. Pulling the id out means the sidecar
 * still reports it, which is the whole reason to want a run id: to go look at
 * one.
 *
 * Anchored to the exact wording of that message, not to any `wrun_` in the
 * string: the error reaches the runner wrapped in the parent fixture's own
 * failure, which names the *parent*, and a loose match takes that instead.
 */
const CREATED_RUN_ID =
  /Workflow run (wrun_[0-9A-Za-z]+) was created, but this deployment's Workflow backend did not store its dynamic workflow code/;

/**
 * Skip the running test when the deployment cannot run dynamic workflows: it
 * has not opted in (unless the lane expects it to have), or its backend has no
 * dynamic-source storage.
 *
 * A real skip rather than a failure, because the gap is the deployment's
 * configuration or the backend's, and the suite cannot close it: these go
 * live, unchanged, once the deployment opts in and the server side ships.
 * Not `expect().toThrow()` either — a passing assertion would be claiming
 * coverage the run never got. Same mechanism as the conformance gate.
 */
function skipIfUnsupportedDeployment(error: unknown): never {
  const unsupported =
    error instanceof Error
      ? UNSUPPORTED_DEPLOYMENT.find(({ pattern }) =>
          pattern.test(error.message)
        )
      : undefined;
  if (
    error instanceof Error &&
    unsupported &&
    !(unsupported.optIn && expectDynamicWorkflows)
  ) {
    const createdRunId = CREATED_RUN_ID.exec(error.message)?.[1];
    if (createdRunId) {
      // Track it before skipping: the run was created and is inspectable,
      // even though nothing can replay it. Labelled, because the sidecar
      // otherwise shows two bare ids per test — the parent fixture's and this
      // one — with nothing saying which is the dynamic run.
      trackRun(getRun(createdRunId), {
        testName: `${getCurrentTest()?.name ?? 'dynamic workflow'} [dynamic run]`,
      });
    }
    getCurrentTest()?.context.skip(
      unsupported.reason +
        (createdRunId ? ` (created, unreplayable run: ${createdRunId})` : '')
    );
  }
  throw error;
}

/** Start a parent fixture and read the dynamic child it reports. */
async function startParent(
  fixture: string,
  args: unknown[]
): Promise<DynamicChild> {
  const parent = await start(await e2e(fixture), args);
  try {
    return (await parent.returnValue) as DynamicChild;
  } catch (error) {
    skipIfUnsupportedDeployment(error);
  }
}

/**
 * Read a run's persisted record.
 *
 * The World rather than `getRun()`: `getRun()` returns a handle of
 * promise-returning getters over a small public surface, and these tests
 * assert on storage — `executionContext` and the stored code bytes.
 * `resolveData: 'all'` is what keeps the payload fields from being stripped.
 */
async function readRunRecord(runId: string) {
  const world = await getWorld();
  return world.runs.get(runId, { resolveData: 'all' });
}

/**
 * Await a child run the deployment started, and return it with its record.
 *
 * The child's ID comes back from the parent, so the runner never held a `Run`
 * for it — `getRun` adopts one, and tracking it gets it into the diagnostics
 * dump and the run-ID sidecar alongside directly-started runs.
 */
async function awaitChildRun(childRunId: string) {
  const child = trackRun(getRun(childRunId), {
    testName: `${getCurrentTest()?.name ?? 'dynamic workflow'} [dynamic run]`,
  });
  const output = await child.returnValue;
  return { output, record: await readRunRecord(childRunId) };
}

/** As above, for a child expected to fail. */
async function awaitChildRunFailure(childRunId: string, timeoutMs = 60_000) {
  trackRun(getRun(childRunId), {
    testName: `${getCurrentTest()?.name ?? 'dynamic workflow'} [dynamic run]`,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readRunRecord(childRunId);
    if (record.status === 'failed' || record.status === 'cancelled') {
      return record;
    }
    if (record.status === 'completed') {
      throw new Error(
        `child run ${childRunId} completed; expected it to fail because its ` +
          'source called a step it was not given'
      );
    }
    await sleep(500);
  }
  throw new Error(`child run ${childRunId} did not fail within ${timeoutMs}ms`);
}

/**
 * Write out the run IDs this file created, so a Vercel run can be opened in
 * the dashboard afterwards.
 *
 * `e2e.test.ts` does the same for its own runs, but each e2e file runs in its
 * own vitest worker with its own copy of the collector — so without this the
 * dynamic runs are tracked in memory and then thrown away, which is exactly
 * what someone asks for when they want to see what a dynamic run looks like in
 * production. Distinct filename because that sidecar is per-app and the last
 * writer would otherwise clobber it.
 */
function writeDynamicRunSidecar() {
  if (!process.env.WORKFLOW_VERCEL_ENV) return;
  const appName = process.env.APP_NAME || 'unknown';
  fs.writeFileSync(
    path.resolve(process.cwd(), `e2e-dynamic-runs-${appName}-vercel.json`),
    JSON.stringify(
      {
        runIds: getCollectedRunIds(),
        vercel: {
          projectSlug: process.env.WORKFLOW_VERCEL_PROJECT_SLUG,
          environment: process.env.WORKFLOW_VERCEL_ENV,
          teamSlug: 'vercel-labs',
        },
      },
      null,
      2
    )
  );
}

afterAll(() => {
  writeDynamicRunSidecar();
  writeInfraSidecar();
});

beforeAll(() => {
  setupWorld(deploymentUrl);
});

beforeEach((ctx) => {
  setupRunTracking(ctx.task.name);
});

/**
 * Dynamic source is JavaScript evaluated in the JS workflow VM, so it is
 * JS-implementation-specific by construction. A non-JS SDK would not be
 * running the same thing, so it skips rather than carrying this as a gap.
 */
const describeJs = isJsApp() ? describe : describe.skip;

describeJs('dynamic workflows e2e', { timeout: 120_000 }, () => {
  it('runs app-generated source against a registered step', async () => {
    const result = await startParent('dynamicWorkflowFromApp', [20]);

    expect(result.parentInput).toBe(20);
    expect(result.childRunId).toMatch(/^wrun_/);

    const child = await awaitChildRun(result.childRunId);
    // A workflow the deployment never bundled, executing against the `add`
    // step it did — bound by the `.stepId` on the imported function.
    expect(child.output).toEqual({ total: 41 });

    // The generated id, derived from the source and its step bindings.
    expect(child.record.workflowName).toMatch(
      /^workflow\/\/dynamic\/[0-9a-f]{32}\/\/workflow$/
    );
    // Plaintext on purpose: it is what identifies a run as dynamic, and
    // exposes the step allowlist it was compiled against, without decrypting
    // the code.
    expect(child.record.executionContext?.dynamicWorkflow).toMatchObject({
      version: 1,
      exportName: 'workflow',
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('stores the generated code with the child run', async () => {
    const result = await startParent('dynamicWorkflowFromApp', [1]);
    const child = await awaitChildRun(result.childRunId);

    const code = (child.record as { dynamicWorkflowCode?: unknown })
      .dynamicWorkflowCode;
    // `start()` only publishes a dynamic run once `run_created` has confirmed
    // the code was stored, so a child that ran must have its code.
    expect(code).toBeInstanceOf(Uint8Array);
    const codeBytes = code as Uint8Array;
    expect(codeBytes.byteLength).toBeGreaterThan(0);

    // Opaque at rest. Where the world encrypts, the source must not be
    // readable off the stored bytes — that is the property that distinguishes
    // ref-backed storage from the prototype's plaintext metadata field.
    const encryptionEnabled = Boolean(
      (
        child.record.executionContext?.features as
          | { encryption?: boolean }
          | undefined
      )?.encryption
    );
    if (encryptionEnabled) {
      expect(new TextDecoder().decode(codeBytes)).not.toContain('use workflow');
    }
  });

  it('replays a suspended child by reading its stored code back', async () => {
    // The delivery that resumes the child holds no in-memory copy of the code
    // and no run input on the message, so it has to read the stored code back
    // and decrypt it. This is what caught `world-local` dropping the code on
    // a run's first status transition.
    const result = await startParent('dynamicWorkflowFromAppWithSleep', [10]);
    const child = await awaitChildRun(result.childRunId);

    expect(child.output).toEqual({ total: 21 });
  });

  it('fails the child when its source calls a step it was not given', async () => {
    // `steps` is frozen and holds only the aliases the app passed, so this is
    // a run failure rather than an unauthorized step dispatch.
    const result = await startParent('dynamicWorkflowDisallowedStep', [3]);
    const record = await awaitChildRunFailure(result.childRunId);

    expect(record.status).toBe('failed');
  });

  it('derives the same workflow id for the same generated source', async () => {
    // Two runs of the fixture generate identical source, so they must land on
    // one durable id — that is what makes runs of a generated workflow group
    // together in observability and share a queue topic.
    const first = await startParent('dynamicWorkflowFromApp', [4]);
    const second = await startParent('dynamicWorkflowFromApp', [4]);

    const [a, b] = await Promise.all([
      awaitChildRun(first.childRunId),
      awaitChildRun(second.childRunId),
    ]);

    expect(a.output).toEqual({ total: 9 });
    expect(b.output).toEqual({ total: 9 });
    expect(a.record.workflowName).toBe(b.record.workflowName);
    expect(a.record.runId).not.toBe(b.record.runId);
  });

  // Client-side validation is the one part of this that genuinely belongs at
  // the runner level: it happens before any write, so no deployment is
  // involved and there is no run to observe. It also runs before the opt-in
  // check, so the runner needs no WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS.
  it('rejects source that cannot be a workflow before creating a run', async () => {
    const steps = { add: { stepId: 'step//./workflows/99_e2e//add' } };

    await expect(
      start('const notAWorkflow = 1;', [], { experimental_dynamic: { steps } })
    ).rejects.toThrow(/must declare `async function workflow/);

    await expect(
      start('async function workflow() { return 1; }', [], {
        experimental_dynamic: { steps },
      })
    ).rejects.toThrow(/"use workflow" directive/);

    await expect(
      start('async function workflow() { "use workflow"; }', [], {
        experimental_dynamic: { steps: {} },
      })
    ).rejects.toThrow(/at least one registered step/);
  });
});

/**
 * Published revisions: bird-survey missions kept as regression coverage for
 * revision checks, hook disposal, and fan-out.
 *
 * The deployment holds only the step catalog and the runner
 * (`dynamicMissionRun` and friends in `workflows/99_e2e.ts`). The missions
 * are published after deploy: this runner plays the operator, building each
 * approved revision and handing it to the unchanged deployment.
 */

/** Mission A, as the recipe publishes it: every detection gets a review. */
const REVIEW_ALL_SOURCE = `
async function workflow(input) {
  "use workflow";
  const detections = await steps.llm({ image: input.image, count: input.count });

  const reviews = await Promise.all(
    detections.map(async (detection) => {
      const token = input.reviewTokenPrefix + ":" + detection.id;
      const review = createHook({ token });
      await steps.expertReview(detection, token);
      const verdict = await review;
      return { ...detection, confirmed: verdict.confirmed === true, reviewedBy: "expert" };
    })
  );

  const confirmed = reviews.filter((review) => review.confirmed).length;
  const result = { image: input.image, confirmed, reviews };
  await steps.notify(input.image + ": " + confirmed + " of " + reviews.length + " confirmed");
  if (input.parentToken) {
    await steps.reportToParent(input.parentToken, result);
  }
  return result;
}
`;

/**
 * Mission B, published later: confident detections are accepted without a
 * review, and a review nobody answers in time counts as unconfirmed.
 */
const TRIAGE_SOURCE = `
async function workflow(input) {
  "use workflow";
  const detections = await steps.llm({ image: input.image, count: input.count });

  const reviews = await Promise.all(
    detections.map(async (detection) => {
      if (detection.confidence >= input.autoAcceptAbove) {
        return { ...detection, confirmed: true, reviewedBy: "auto" };
      }
      const token = input.reviewTokenPrefix + ":" + detection.id;
      const review = createHook({ token });
      try {
        await steps.expertReview(detection, token);
        const verdict = await Promise.race([
          review,
          sleep(input.reviewTimeout).then(() => null),
        ]);
        if (verdict === null) {
          return { ...detection, confirmed: false, reviewedBy: "timeout" };
        }
        return { ...detection, confirmed: verdict.confirmed === true, reviewedBy: "expert" };
      } finally {
        // Release the token, so a response after the timeout is refused
        // instead of resolving a hook nothing reads.
        review.dispose();
      }
    })
  );

  const confirmed = reviews.filter((review) => review.confirmed).length;
  const result = { image: input.image, confirmed, reviews };
  await steps.notify(input.image + ": " + confirmed + " of " + reviews.length + " confirmed");
  if (input.parentToken) {
    await steps.reportToParent(input.parentToken, result);
  }
  return result;
}
`;

/** Alias the source calls -> catalog step name, for both missions. */
const MISSION_STEPS = {
  llm: 'detectBirds',
  expertReview: 'requestExpertReview',
  notify: 'notify',
  reportToParent: 'reportToParent',
};

/** The operator path: an approved, immutable revision of a mission. */
function publishRevision(
  missionId: string,
  revision: number,
  source: string,
  {
    steps = MISSION_STEPS,
    catalogVersion = 'birds@1',
  }: { steps?: Record<string, string>; catalogVersion?: string } = {}
) {
  return {
    missionId,
    revision,
    source,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    steps,
    catalogVersion,
    approval: {
      approvedBy: 'e2e-operator',
      approvedAt: new Date().toISOString(),
    },
  };
}

const MISSION_A = publishRevision('review-all', 1, REVIEW_ALL_SOURCE);
const MISSION_B = publishRevision('triage', 1, TRIAGE_SOURCE);

/** Every event in a run's log, oldest first. */
async function allRunEvents(runId: string) {
  const world = await getWorld();
  const events: { eventType: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await world.events.list({
      runId,
      pagination: { limit: 100, cursor, sortOrder: 'asc' },
    });
    events.push(...(page.data as { eventType: string }[]));
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return events;
}

/**
 * Resume a hook a dynamic mission creates, once it exists.
 *
 * Missions create their hooks deep inside a dynamic child, so there is no run
 * to wait on first: poll the token until it resolves, then resume it once.
 * When a `parent` is given (the fan-out case, where the runner never learns
 * the children's run IDs up front), a failed parent is checked against the
 * unsupported-deployment refusals, so a lane that cannot run dynamic
 * workflows skips here instead of timing out on a hook that will never exist.
 */
async function resumeMissionHook(
  token: string,
  payload: unknown,
  {
    parent,
    timeoutMs = 60_000,
  }: { parent?: Run<unknown>; timeoutMs?: number } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const hook = await getHookByToken(token);
      await resumeHook(hook, payload);
      return hook;
    } catch (error) {
      lastError = error;
    }
    if (parent && (await parent.status) === 'failed') {
      try {
        await parent.returnValue;
      } catch (error) {
        skipIfUnsupportedDeployment(error);
      }
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for hook ${token}. Last error: ${String(lastError)}`
  );
}

describeJs(
  'dynamic workflows: published revisions',
  { timeout: 120_000 },
  () => {
    it('runs a published mission that reviews every detection', async () => {
      const prefix = `e2e-dynamic-review:${crypto.randomUUID()}`;
      const { childRunId } = await startParent('dynamicMissionRun', [
        MISSION_A,
        { image: 'backyard.jpg', count: 3, reviewTokenPrefix: prefix },
      ]);

      // Every review waits on its own hook, in parallel; resume them out of
      // order to show nothing depends on arrival order.
      const verdicts = [true, false, true];
      for (const id of [2, 0, 1]) {
        const hook = await resumeMissionHook(`${prefix}:${id}`, {
          confirmed: verdicts[id],
        });
        expect(hook.runId).toBe(childRunId);
      }

      const child = await awaitChildRun(childRunId);
      expect(child.output).toEqual({
        image: 'backyard.jpg',
        confirmed: 2,
        reviews: [
          {
            id: 0,
            species: 'American robin',
            confidence: 0.97,
            confirmed: true,
            reviewedBy: 'expert',
          },
          {
            id: 1,
            species: 'Blue jay',
            confidence: 0.62,
            confirmed: false,
            reviewedBy: 'expert',
          },
          {
            id: 2,
            species: 'Northern cardinal',
            confidence: 0.91,
            confirmed: true,
            reviewedBy: 'expert',
          },
        ],
      });
    });

    it('runs a mission published after deploy that only reviews uncertain detections', async () => {
      const prefix = `e2e-dynamic-triage:${crypto.randomUUID()}`;
      const { childRunId } = await startParent('dynamicMissionRun', [
        MISSION_B,
        {
          image: 'feeder.jpg',
          count: 4,
          reviewTokenPrefix: prefix,
          autoAcceptAbove: 0.9,
          reviewTimeout: '10m',
        },
      ]);

      // Detections 1 and 3 are under the threshold; 0 and 2 never get a hook.
      await resumeMissionHook(`${prefix}:1`, { confirmed: true });
      await resumeMissionHook(`${prefix}:3`, { confirmed: false });

      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        image: 'feeder.jpg',
        confirmed: 3,
        reviews: [
          { id: 0, confirmed: true, reviewedBy: 'auto' },
          { id: 1, confirmed: true, reviewedBy: 'expert' },
          { id: 2, confirmed: true, reviewedBy: 'auto' },
          { id: 3, confirmed: false, reviewedBy: 'expert' },
        ],
      });
      await expect(getHookByToken(`${prefix}:0`)).rejects.toThrow(/not found/i);
    });

    it('closes and disposes a review nobody answers when its timeout fires', async () => {
      const prefix = `e2e-dynamic-triage:${crypto.randomUUID()}`;
      const { childRunId } = await startParent('dynamicMissionRun', [
        MISSION_B,
        {
          image: 'porch.jpg',
          count: 2,
          reviewTokenPrefix: prefix,
          autoAcceptAbove: 0.9,
          reviewTimeout: '2s',
        },
      ]);

      // The durable sleep wins the race, so the run completes with no resume.
      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        confirmed: 1,
        reviews: [
          { id: 0, reviewedBy: 'auto' },
          { id: 1, confirmed: false, reviewedBy: 'timeout' },
        ],
      });

      // The mission disposed the timed-out review's hook itself. Completion
      // removes a run's remaining hooks without logging a `hook_disposed`, so
      // this event is the source's dispose(). (Not ordered against
      // `run_completed`: under load that event can trail the run's result.)
      const events = await allRunEvents(childRunId);
      expect(events.map((event) => event.eventType)).toContain('hook_disposed');

      // A late response is refused rather than delivered.
      await expect(getHookByToken(`${prefix}:1`)).rejects.toThrow(/not found/i);
    });

    it('gives a revision that differs only in whitespace a new workflow id', async () => {
      // One confident detection, so both runs finish without a review.
      const input = {
        image: 'wire.jpg',
        count: 1,
        reviewTokenPrefix: `e2e-dynamic-triage:${crypto.randomUUID()}`,
        autoAcceptAbove: 0.9,
        reviewTimeout: '10m',
      };
      const reformatted = publishRevision('triage', 2, `${TRIAGE_SOURCE}\n`);
      const [first, second] = await Promise.all([
        startParent('dynamicMissionRun', [MISSION_B, input]),
        startParent('dynamicMissionRun', [reformatted, input]),
      ]);

      const [a, b] = await Promise.all([
        awaitChildRun(first.childRunId),
        awaitChildRun(second.childRunId),
      ]);
      expect(a.output).toEqual(b.output);
      expect(a.record.workflowName).not.toBe(b.record.workflowName);
    });

    it('refuses a stored revision whose source does not match its recorded hash', async () => {
      const tampered = {
        ...MISSION_B,
        source: TRIAGE_SOURCE.replace('>= input.autoAcceptAbove', '>= 0'),
      };
      const parent = await start(await e2e('dynamicMissionRun'), [
        tampered,
        { image: 'x.jpg', count: 1, reviewTokenPrefix: 'unused' },
      ]);
      await expect(parent.returnValue).rejects.toThrow(
        /does not match its recorded hash/
      );
    });

    it('fans missions out from a static parent and back in through hooks', async () => {
      const surveyKey = `e2e-dynamic-survey:${crypto.randomUUID()}`;
      const parent = await start(await e2e('dynamicMissionFanOut'), [
        MISSION_A,
        surveyKey,
        ['north.jpg', 'south.jpg'],
      ]);

      // Each child mission makes one detection and waits on its review.
      for (const [index, confirmed] of [true, false].entries()) {
        const hook = await resumeMissionHook(
          `${surveyKey}:review:${index}:0`,
          { confirmed },
          { parent }
        );
        trackRun(getRun(hook.runId), {
          testName: `${getCurrentTest()?.name ?? 'dynamic workflow'} [dynamic run]`,
        });
      }

      let output: unknown;
      try {
        output = await parent.returnValue;
      } catch (error) {
        skipIfUnsupportedDeployment(error);
      }
      expect(output).toMatchObject({
        images: 2,
        confirmed: 1,
        results: [
          { image: 'north.jpg', confirmed: 1 },
          { image: 'south.jpg', confirmed: 0 },
        ],
      });
    });
  }
);

/**
 * The customer-migration procedures in the "Dynamic Workflows" cookbook
 * recipe. The deployment holds only the migration catalog (a simulated
 * destination; see `99_e2e.ts`). Both procedures exist only here, published
 * after deploy, and must converge on the same destination records. Procedure
 * A appears in the recipe byte-for-byte, and an excerpt of B; keep them in
 * sync.
 */

/** Procedure A: account families in parallel, parent-first, one review only where owners disagree. */
const PARENT_FIRST_SOURCE = `
async function workflow(input) {
  "use workflow";
  const scope = { migrationId: input.migrationId, destinationId: input.destinationId };

  const rows = [];
  let cursor;
  do {
    const page = await steps.readSourcePage({ dataset: input.dataset, cursor });
    rows.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // This customer's rules: a family is every account under one contract root,
  // accounts on the same contract are one account, and a contact is one person
  // per normalized email within a family.
  const accounts = rows.filter((row) => row.kind === "account");
  const contacts = rows.filter((row) => row.kind === "contact");
  const families = new Map();
  for (const row of accounts) {
    const family = row.contract.split("/")[0];
    families.set(family, [...(families.get(family) || []), row]);
  }

  function familyOperations(members, owner) {
    // Parent-first: an account is written only after the account it reports to.
    const ordered = [];
    const visit = (row) => {
      if (ordered.includes(row)) return;
      const parent = members.find((other) => other.id === row.parent);
      if (parent) visit(parent);
      ordered.push(row);
    };
    members.forEach(visit);

    const ops = [];
    const survivors = new Map();
    const survivorOf = new Map();
    for (const row of ordered) {
      ops.push({ op: "createAccount", key: row.id, name: row.name, owner: row.owner, sources: [row.id] });
      if (row.parent) ops.push({ op: "setParent", account: row.id, parent: row.parent });
      const survivor = survivors.get(row.contract);
      if (!survivor) {
        survivors.set(row.contract, row.id);
        survivorOf.set(row.id, row.id);
        continue;
      }
      survivorOf.set(row.id, survivor);
      if (owner) {
        ops.push({ op: "setOwner", key: survivor, owner }, { op: "setOwner", key: row.id, owner });
      }
      ops.push({ op: "mergeAccount", from: row.id, into: survivor });
    }

    const people = new Map();
    for (const row of contacts) {
      if (!survivorOf.has(row.account)) continue;
      const email = row.email.trim().toLowerCase();
      const person = people.get(email) || { key: row.id, name: row.name, email, sources: [], accounts: [] };
      person.sources.push(row.id);
      person.accounts.push(survivorOf.get(row.account));
      people.set(email, person);
    }
    for (const person of people.values()) {
      ops.push({ op: "createContact", key: person.key, name: person.name, email: person.email, sources: person.sources });
      for (const account of new Set(person.accounts)) {
        ops.push({ op: "linkContact", contact: person.key, account });
      }
    }
    return ops;
  }

  async function migrateFamily(family, members) {
    const stage = (owner) =>
      steps.stageChanges({ ...scope, groupKey: family, operations: familyOperations(members, owner) });
    let plan = await stage();
    if (plan.conflicts.length > 0) {
      // Only this family waits for a person; the others carry on.
      const token = input.tokenPrefix + ":" + family;
      const review = createHook({ token });
      try {
        const owners = plan.conflicts.flatMap((conflict) => conflict.values);
        await steps.requestApproval({ planId: plan.planId, token, summary: family + ": choose an owner from " + owners.join(", ") });
        const decision = await review;
        if (!decision.approved) return { family, status: "skipped" };
        plan = await stage(decision.owner || owners[0]);
      } finally {
        review.dispose();
      }
    }
    const result = await steps.applyChanges({ plan, idempotencyKey: "apply:" + plan.planId });
    return { family, status: "applied", result };
  }

  const outcomes = await Promise.all([...families].map(([family, members]) => migrateFamily(family, members)));
  const verification = await steps.verifyChanges({
    ...scope,
    results: outcomes.filter((outcome) => outcome.result).map((outcome) => outcome.result),
  });
  const summary = outcomes.map(({ family, status }) => ({ family, status }));
  const report = await steps.publishReport({ migrationId: input.migrationId, results: { families: summary, verification } });
  return { families: summary, verification, report };
}
`;

/** Procedure B: load everything provisional first, then one reviewed consolidation. */
const PROVISIONAL_FIRST_SOURCE = `
async function workflow(input) {
  "use workflow";
  const scope = { migrationId: input.migrationId, destinationId: input.destinationId };

  const rows = [];
  let cursor;
  do {
    const page = await steps.readSourcePage({ dataset: input.dataset, cursor });
    rows.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const accounts = rows.filter((row) => row.kind === "account");
  const contacts = rows.filter((row) => row.kind === "contact");

  // 1. Land every row as written: provisional, flat, one record per row.
  const load = await steps.stageChanges({
    ...scope,
    groupKey: "load",
    operations: [
      ...accounts.map((row) => ({ op: "createAccount", key: row.id, name: row.name, owner: row.owner, status: "provisional", sources: [row.id] })),
      ...contacts.flatMap((row) => [
        { op: "createContact", key: row.id, name: row.name, email: row.email.trim().toLowerCase(), sources: [row.id] },
        { op: "linkContact", contact: row.id, account: row.account },
      ]),
    ],
  });
  const loaded = await steps.applyChanges({ plan: load, idempotencyKey: "apply:" + load.planId });

  // 2. Reconcile the landed records with this customer's rules, as one change.
  function consolidation(owner) {
    const ops = [];
    for (const row of accounts) {
      if (row.parent) ops.push({ op: "setParent", account: row.id, parent: row.parent });
    }
    const survivors = new Map();
    for (const row of accounts) {
      const survivor = survivors.get(row.contract);
      if (!survivor) {
        survivors.set(row.contract, row.id);
        continue;
      }
      if (owner) ops.push({ op: "setOwner", key: survivor, owner }, { op: "setOwner", key: row.id, owner });
      ops.push({ op: "mergeAccount", from: row.id, into: survivor });
    }
    const people = new Map();
    for (const row of contacts) {
      const holder = accounts.find((account) => account.id === row.account);
      const identity = holder.contract.split("/")[0] + ":" + row.email.trim().toLowerCase();
      const person = people.get(identity);
      if (person) ops.push({ op: "mergeContact", from: row.id, into: person });
      else people.set(identity, row.id);
    }
    for (const key of survivors.values()) ops.push({ op: "markFinal", key });
    return ops;
  }
  const stage = (owner) =>
    steps.stageChanges({ ...scope, groupKey: "consolidation", operations: consolidation(owner), dependsOn: [load] });
  let plan = await stage();

  // One review for the whole consolidation, not one per family.
  const token = input.tokenPrefix + ":consolidation";
  const review = createHook({ token });
  let decision;
  try {
    const owners = plan.conflicts.flatMap((conflict) => conflict.values);
    await steps.requestApproval({ planId: plan.planId, token, summary: plan.operations.length + " changes; owners to choose from: " + owners.join(", ") });
    decision = await review;
    if (decision.approved && plan.conflicts.length > 0) plan = await stage(decision.owner || owners[0]);
  } finally {
    review.dispose();
  }

  const results = [loaded];
  if (decision.approved) {
    results.push(await steps.applyChanges({ plan, idempotencyKey: "apply:" + plan.planId }));
  }
  const verification = await steps.verifyChanges({ ...scope, results });
  const report = await steps.publishReport({ migrationId: input.migrationId, results: { approved: decision.approved, verification } });
  return { approved: decision.approved, stages: results.map((result) => result.applied), verification, report };
}
`;

/** Changes a staged plan before applying it, which the adapter must refuse. */
const TAMPERED_PLAN_SOURCE = `
async function workflow(input) {
  "use workflow";
  const plan = await steps.stageChanges({
    migrationId: input.migrationId,
    destinationId: input.destinationId,
    groupKey: "tampered",
    operations: [{ op: "createAccount", key: "acct-a", name: "A", owner: "dana", sources: [] }],
  });
  plan.operations.push({ op: "createAccount", key: "acct-b", name: "B", owner: "dana", sources: [] });
  return await steps.applyChanges({ plan, idempotencyKey: "apply:" + plan.planId });
}
`;

const MIGRATION_CATALOG_STEPS = Object.fromEntries(
  [
    'readSourcePage',
    'lookupDestination',
    'stageChanges',
    'requestApproval',
    'applyChanges',
    'verifyChanges',
    'publishReport',
  ].map((name) => [name, name])
);

const publishProcedure = (id: string, source: string) =>
  publishRevision(id, 1, source, {
    steps: MIGRATION_CATALOG_STEPS,
    catalogVersion: 'crm-migration@1',
  });

const PROCEDURE_A = publishProcedure('acme-parent-first', PARENT_FIRST_SOURCE);
const PROCEDURE_B = publishProcedure(
  'acme-provisional-first',
  PROVISIONAL_FIRST_SOURCE
);

function migrationInput() {
  const id = crypto.randomUUID();
  return {
    dataset: 'acme-legacy',
    migrationId: `migration-${id}`,
    destinationId: `destination-${id}`,
    tokenPrefix: `e2e-migration:${id}`,
  };
}

/** Wait until a hook exists for `token`, without resuming it. */
async function waitForMissionHook(token: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getHookByToken(token);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `No hook ${token} after ${timeoutMs}ms: ${String(lastError)}`
  );
}

/** How many `applyChanges` calls a run has completed so far. */
async function completedApplies(runId: string) {
  const world = await getWorld();
  const page = await world.steps.list({
    runId,
    pagination: { limit: 100, sortOrder: 'asc' },
    resolveData: 'none',
  });
  return page.data.filter(
    (step) =>
      step.stepName.endsWith('//applyChanges') && step.status === 'completed'
  ).length;
}

/** The destination records both procedures must end with. */
const MIGRATED_ACCOUNTS = [
  { key: 'acct-acme', parent: null, owner: 'dana', status: 'final' },
  {
    key: 'acct-acme-east',
    parent: 'acct-acme',
    owner: 'dana',
    status: 'final',
  },
  {
    key: 'acct-acme-west',
    parent: 'acct-acme',
    owner: 'dana',
    status: 'final',
  },
  { key: 'acct-globex', parent: null, owner: 'lee', status: 'final' },
  {
    key: 'acct-initech',
    parent: null,
    owner: 'sam',
    status: 'final',
    sources: ['acct-initech', 'acct-initech-ltd'],
  },
];
const MIGRATED_CONTACTS = [
  {
    key: 'ct-ada-east',
    email: 'ada@acme.com',
    accounts: ['acct-acme-east', 'acct-acme-west'],
    sources: ['ct-ada-east', 'ct-ada-west'],
  },
  { key: 'ct-info-globex', accounts: ['acct-globex'] },
  { key: 'ct-info-initech', accounts: ['acct-initech'] },
];

describeJs(
  'dynamic workflows: customer migration recipe',
  { timeout: 120_000 },
  () => {
    it('procedure A finishes independent families while one waits for review', async () => {
      const input = migrationInput();
      const { childRunId } = await startParent('dynamicMissionRun', [
        PROCEDURE_A,
        input,
      ]);

      const hook = await waitForMissionHook(`${input.tokenPrefix}:C-300`);
      expect(hook.runId).toBe(childRunId);
      // Acme and Globex apply while Initech is still waiting for a person.
      const deadline = Date.now() + 30_000;
      while (
        (await completedApplies(childRunId)) < 2 &&
        Date.now() < deadline
      ) {
        await sleep(250);
      }
      expect(await completedApplies(childRunId)).toBe(2);
      expect((await readRunRecord(childRunId)).status).not.toBe('completed');

      await resumeHook(hook, { approved: true, owner: 'sam' });
      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        families: [
          { family: 'C-100', status: 'applied' },
          { family: 'C-200', status: 'applied' },
          { family: 'C-300', status: 'applied' },
        ],
        verification: {
          ok: true,
          violations: [],
          counts: { accounts: 5, contacts: 3, provisional: 0 },
          accounts: MIGRATED_ACCOUNTS,
          contacts: MIGRATED_CONTACTS,
        },
      });
    });

    it('procedure A leaves a rejected family out and migrates the rest', async () => {
      const input = migrationInput();
      const { childRunId } = await startParent('dynamicMissionRun', [
        PROCEDURE_A,
        input,
      ]);
      await resumeMissionHook(`${input.tokenPrefix}:C-300`, {
        approved: false,
      });

      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        families: [
          { family: 'C-100', status: 'applied' },
          { family: 'C-200', status: 'applied' },
          { family: 'C-300', status: 'skipped' },
        ],
        verification: {
          ok: true,
          accounts: MIGRATED_ACCOUNTS.slice(0, 4),
          contacts: MIGRATED_CONTACTS.slice(0, 2),
        },
      });
    });

    it('procedure B, published later, loads provisionally and converges after one review', async () => {
      const input = migrationInput();
      const { childRunId } = await startParent('dynamicMissionRun', [
        PROCEDURE_B,
        input,
      ]);

      const hook = await waitForMissionHook(
        `${input.tokenPrefix}:consolidation`
      );
      // Every row has already landed provisionally; nothing is consolidated.
      expect(await completedApplies(childRunId)).toBe(1);

      await resumeHook(hook, { approved: true, owner: 'sam' });
      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        approved: true,
        verification: {
          ok: true,
          violations: [],
          counts: { accounts: 5, contacts: 3, provisional: 0 },
          accounts: MIGRATED_ACCOUNTS,
          contacts: MIGRATED_CONTACTS,
        },
      });
    });

    it('procedure B reports provisional records when the consolidation is rejected', async () => {
      const input = migrationInput();
      const { childRunId } = await startParent('dynamicMissionRun', [
        PROCEDURE_B,
        input,
      ]);
      await resumeMissionHook(`${input.tokenPrefix}:consolidation`, {
        approved: false,
      });

      const child = await awaitChildRun(childRunId);
      expect(child.output).toMatchObject({
        approved: false,
        verification: {
          ok: false,
          counts: { accounts: 6, contacts: 4, provisional: 6 },
        },
      });
    });

    it('refuses a plan changed after it was staged', async () => {
      const { childRunId } = await startParent('dynamicMissionRun', [
        publishProcedure('tampered', TAMPERED_PLAN_SOURCE),
        migrationInput(),
      ]);
      const child = trackRun(getRun(childRunId), {
        testName: `${getCurrentTest()?.name ?? 'dynamic workflow'} [dynamic run]`,
      });
      await expect(child.returnValue).rejects.toThrow(
        /changed after it was staged/
      );
    });
  }
);
