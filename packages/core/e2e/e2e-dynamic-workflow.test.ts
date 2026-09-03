/**
 * E2E tests for dynamic workflows: runs started from workflow source rather
 * than from a workflow function in the deployment's build-time manifest.
 *
 * What makes these worth running against a real deployment, rather than
 * covering in unit tests, is the round trip. `start()` compiles the source
 * here, the backend stores the compiled code encrypted with the run's key,
 * and a *different* process — the deployed handler — reads it back, decrypts
 * it, and evaluates it in the workflow VM on every replay. Nothing short of
 * an end-to-end run exercises that.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-dynamic-workflow.test.ts
 */
import { getCurrentTest } from '@vitest/runner';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run, start as rawStart } from '../src/runtime';
import { getRun } from '../src/runtime';
import {
  getStepMetadata,
  isJsApp,
  setupRunTracking,
  setupWorld,
  startTracked,
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

/**
 * The message `start()` throws when the deployment's backend accepted the run
 * but did not persist its workflow code — i.e. a backend that predates
 * dynamic-source storage.
 */
const UNSUPPORTED_BACKEND = /did not store the dynamic workflow code/;

/**
 * Skip the running test when the deployment's backend has no dynamic-source
 * storage, and rethrow anything else.
 *
 * A real skip rather than a failure, because the gap is the backend's and the
 * suite cannot close it: these tests go live, unchanged, once the server side
 * ships. Also not `expect().toThrow()` — a passing assertion would claim
 * coverage the run never got. Same mechanism the conformance gate uses (see
 * `requireSupported` in ./utils).
 */
function skipIfUnsupportedBackend(error: unknown): never {
  if (error instanceof Error && UNSUPPORTED_BACKEND.test(error.message)) {
    getCurrentTest()?.context.skip(
      "this deployment's Workflow backend has no dynamic-source storage yet"
    );
  }
  throw error;
}

afterAll(() => {
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
 * JS-implementation-specific by construction — a non-JS SDK would not run the
 * same thing. Skipped rather than carried as a conformance gap.
 */
const describeJs = isJsApp() ? describe : describe.skip;

describeJs('dynamic workflows e2e', { timeout: 120_000 }, () => {
  // `add(a, b)` from workflows/99_e2e.ts. Resolved from the deployed manifest:
  // the runner is a separate process and cannot import the step to read
  // `.stepId` off it.
  let add: { stepId: string };

  beforeAll(async () => {
    add = await getStepMetadata(deploymentUrl, 'workflows/99_e2e.ts', 'add');
  });

  it('runs generated source over registered steps', async () => {
    const source = `
async function workflow(input) {
  "use workflow";
  const doubled = await steps.add(input.value, input.value);
  const plusOne = await steps.add(doubled, 1);
  return { result: plusOne };
}
`;

    let run: Run<unknown>;
    try {
      run = await start(source, [{ value: 20 }], {
        dynamic: { steps: { add } },
      });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }

    // The whole point: a deployment that never bundled this function executed
    // it, and its steps dispatched to the real registered step.
    expect(await run.returnValue).toEqual({ result: 41 });
  });

  it('derives a stable workflow id from the source', async () => {
    const source = `
async function workflow() {
  "use workflow";
  return await steps.add(1, 1);
}
`;

    let first: Run<unknown>;
    try {
      first = await start(source, [], { dynamic: { steps: { add } } });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }
    const second = await start(source, [], { dynamic: { steps: { add } } });

    expect(await first.returnValue).toBe(2);
    expect(await second.returnValue).toBe(2);

    const [a, b] = await Promise.all([
      getRun(first.runId),
      getRun(second.runId),
    ]);
    // Same definition ⇒ same durable id, so runs of one generated workflow
    // group together and share a queue topic.
    expect(a.workflowName).toBe(b.workflowName);
    expect(a.workflowName).toMatch(
      /^workflow\/\/dynamic\/[0-9a-f]{32}\/\/workflow$/
    );
  });

  it('stores the workflow code encrypted, with plaintext metadata beside it', async () => {
    const source = `
async function workflow() {
  "use workflow";
  return await steps.add(2, 3);
}
`;

    let run: Run<unknown>;
    try {
      run = await start(source, [], { dynamic: { steps: { add } } });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }
    expect(await run.returnValue).toBe(5);

    const stored = await getRun(run.runId);

    // The marker is plaintext on purpose: it is what lets a run be identified
    // as dynamic, and its step allowlist audited, without decrypting the code.
    expect(stored.executionContext?.dynamicWorkflow).toMatchObject({
      version: 1,
      exportName: 'workflow',
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      steps: { add: add.stepId },
    });

    // The code itself comes back as opaque bytes, and — where the world
    // encrypts — must not contain the source in the clear. This is the
    // property that distinguishes ref-backed storage from the prototype's
    // plaintext `executionContext` field.
    const code = (stored as { dynamicWorkflowCode?: unknown })
      .dynamicWorkflowCode;
    expect(code).toBeInstanceOf(Uint8Array);
    const codeBytes = code as Uint8Array;
    expect(codeBytes.byteLength).toBeGreaterThan(0);

    const encryptionEnabled = Boolean(
      (
        stored.executionContext?.features as
          | { encryption?: boolean }
          | undefined
      )?.encryption
    );
    if (encryptionEnabled) {
      expect(new TextDecoder().decode(codeBytes)).not.toContain('use workflow');
    }
  });

  it('replays across a suspension, reading its code back on each delivery', async () => {
    // A sleep forces the run out of the invocation that started it, so the
    // delivery that resumes it has to resolve the stored code again — with no
    // in-memory copy and, on the turbo path, no run read it would otherwise
    // have done.
    const source = `
async function workflow(input) {
  "use workflow";
  const before = await steps.add(input.value, 1);
  await sleep("2s");
  const after = await steps.add(before, 1);
  return { before, after };
}
`;

    let run: Run<unknown>;
    try {
      run = await start(source, [{ value: 1 }], {
        dynamic: { steps: { add } },
      });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }

    expect(await run.returnValue).toEqual({ before: 2, after: 3 });
  });

  it('stores a large definition through the deferred ref path', async () => {
    // Padding pushes the serialized code past the inline cutoff so it takes
    // the upload-then-reference path instead of riding the creating write.
    // Distinct string literals, not repeated ones, so compression cannot
    // collapse it back under the threshold.
    const padding = Array.from(
      { length: 900 },
      (_, i) =>
        `  const pad${i} = "dynamic-workflow-padding-${i}-${Math.floor(i * 7919).toString(36)}";`
    ).join('\n');

    const source = `
async function workflow(input) {
  "use workflow";
${padding}
  return await steps.add(input.value, 1);
}
`;

    let run: Run<unknown>;
    try {
      run = await start(source, [{ value: 41 }], {
        dynamic: { steps: { add } },
      });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }

    expect(await run.returnValue).toBe(42);

    const stored = await getRun(run.runId);
    const code = (stored as { dynamicWorkflowCode?: unknown })
      .dynamicWorkflowCode;
    expect(code).toBeInstanceOf(Uint8Array);
    // Read back through the ref, so the run executed code the creating write
    // never carried.
    expect((code as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it('fails the run when the source calls a step it was not given', async () => {
    // The allowlist guardrail, end to end: `steps` is frozen and holds only
    // the aliases that were passed, so this is a run failure rather than an
    // arbitrary step dispatch.
    const source = `
async function workflow() {
  "use workflow";
  return await steps.notAllowed(1, 2);
}
`;

    let run: Run<unknown>;
    try {
      run = await start(source, [], { dynamic: { steps: { add } } });
    } catch (error) {
      skipIfUnsupportedBackend(error);
    }

    await expect(run.returnValue).rejects.toThrow();
    expect((await getRun(run.runId)).status).toBe('failed');
  });

  it('rejects source that cannot be a workflow before creating a run', async () => {
    // Validation runs before any write, so a definition that could never
    // execute costs a rejected call rather than a run nothing can replay.
    // Deliberately no "and no run was created" assertion: the run listing is
    // served from an eventually-consistent store here, so comparing it before
    // and after would be a flake, and the ordering it would be checking is
    // pinned deterministically by the unit tests.
    await expect(
      start('const notAWorkflow = 1;', [], { dynamic: { steps: { add } } })
    ).rejects.toThrow(/must declare `async function workflow/);

    await expect(
      start('async function workflow() { return 1; }', [], {
        dynamic: { steps: { add } },
      })
    ).rejects.toThrow(/"use workflow" directive/);

    await expect(
      start('async function workflow() { "use workflow"; }', [], {
        dynamic: { steps: {} },
      })
    ).rejects.toThrow(/at least one registered step/);
  });
});
