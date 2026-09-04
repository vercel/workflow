/**
 * E2E tests for dynamic workflows: runs started from workflow source rather
 * than from a workflow function in the deployment's build-time manifest.
 *
 * The workflows under test are **generated inside the deployment**, by the
 * fixtures in `workflows/99_e2e.ts` (`dynamicWorkflowFromApp` and friends).
 * That is deliberate, and it is most of the reason this is worth testing end
 * to end at all:
 *
 * - `dynamic.steps` is given the *imported* `add` step function, so the
 *   `.stepId` the build-time transform stamped on it is what binds the source
 *   to a registered step. This runner cannot do that — it holds no handle on
 *   the function — and would have to fall back to an explicit `{ stepId }`.
 * - The source is assembled at runtime by app code, which is how a builder UI
 *   or an LLM-generated plan actually reaches `start()`.
 * - The deployed handler compiles, stores, reads back and evaluates the code
 *   in its own process, on every delivery.
 *
 * So each test starts a *static* fixture, which starts a *dynamic* child, and
 * then asserts on the child. Runs against every world the matrix covers —
 * Vercel, local dev/prod, and Postgres — with no per-world branching.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-dynamic-workflow.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getCurrentTest } from '@vitest/runner';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run, start as rawStart } from '../src/runtime';
import { getRun, getWorld } from '../src/runtime';
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
 * The message `start()` throws when the backend accepted the run but did not
 * persist its workflow code — i.e. a backend that predates dynamic-source
 * storage. It happens inside the fixture's step, so it reaches the runner
 * wrapped in the parent's failure.
 */
const UNSUPPORTED_BACKEND = /did not store the dynamic workflow code/;

/**
 * Skip the running test when the deployment's backend has no dynamic-source
 * storage.
 *
 * A real skip rather than a failure, because the gap is the backend's and the
 * suite cannot close it: these go live, unchanged, once the server side ships.
 * Not `expect().toThrow()` either — a passing assertion would be claiming
 * coverage the run never got. Same mechanism as the conformance gate.
 */
function skipIfUnsupportedBackend(error: unknown): never {
  if (error instanceof Error && UNSUPPORTED_BACKEND.test(error.message)) {
    getCurrentTest()?.context.skip(
      "this deployment's Workflow backend has no dynamic-source storage yet"
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
    skipIfUnsupportedBackend(error);
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
  const child = trackRun(getRun(childRunId));
  const output = await child.returnValue;
  return { output, record: await readRunRecord(childRunId) };
}

/** As above, for a child expected to fail. */
async function awaitChildRunFailure(childRunId: string, timeoutMs = 60_000) {
  trackRun(getRun(childRunId));
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
    if (code === undefined) {
      // Same "no dynamic-source storage" fact, reached a step later:
      // `start()`'s fail-fast check reads the created run off its own
      // response, and a resilient start has no response to read — so a short
      // dynamic run can still finish (turbo runs it from the queue message
      // inside one invocation) while the backend stored nothing.
      getCurrentTest()?.context.skip(
        "this deployment's Workflow backend has no dynamic-source storage yet: the run completed from the queue message without its code being persisted"
      );
    }
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
  // involved and there is no run to observe.
  it('rejects source that cannot be a workflow before creating a run', async () => {
    const steps = { add: { stepId: 'step//./workflows/99_e2e//add' } };

    await expect(
      start('const notAWorkflow = 1;', [], { dynamic: { steps } })
    ).rejects.toThrow(/must declare `async function workflow/);

    await expect(
      start('async function workflow() { return 1; }', [], {
        dynamic: { steps },
      })
    ).rejects.toThrow(/"use workflow" directive/);

    await expect(
      start('async function workflow() { "use workflow"; }', [], {
        dynamic: { steps: {} },
      })
    ).rejects.toThrow(/at least one registered step/);
  });
});
