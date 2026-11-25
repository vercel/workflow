import { RUN_ERROR_CODES } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { hydrateRunError } from '../../serialization.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { DYNAMIC_WORKFLOWS_ENV } from '../constants.js';
import { start } from '../start.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A step that starts a dynamic workflow on a deployment that has not opted
// in, with the workflow not catching the refusal. The opt-in is the project's
// configuration, so the run fails as USER_ERROR, not RUNTIME_ERROR, on both
// engines: the error's name has to survive the step's serialization, the
// revival in the workflow VM (a plain Error carrying the name), and the run
// failure's classification, which is a name-based `.is()` check.

let attempts = 0;
registerStepFunction('dynamic_opt_in_refusal_start', async () => {
  attempts++;
  await start('async function workflow() { "use workflow"; return 1; }', {
    experimental_dynamic: {
      steps: { noop: { stepId: 'step//./test//noop' } },
    },
  });
});

const code = `const startDynamic = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("dynamic_opt_in_refusal_start");
  async function workflow() {
    await startDynamic();
    return 'unreachable';
  }${registerWorkflow()}`;

beforeEach(() => {
  attempts = 0;
  vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, undefined);
  vi.spyOn(runtimeLogger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('start() refused for a missing dynamic opt-in inside a step (%s engine)', (engine) => {
  it('fails the step once and the run with USER_ERROR', async () => {
    const { world, runId } = await setupOrchestratorRun(code, [], {}, engine);
    await world.runUntilIdle();

    // Fatal: the step body ran once and was not retried.
    expect(attempts).toBe(1);
    expect(eventsOf(world, 'step_failed')).toHaveLength(1);
    expect(eventsOf(world, 'step_retrying')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);

    const failed = eventsOf(world, 'run_failed');
    expect(failed).toHaveLength(1);
    expect(dataOf(failed[0])?.errorCode).toBe(RUN_ERROR_CODES.USER_ERROR);

    const error = await hydrateRunError(
      dataOf(failed[0])?.error as Uint8Array,
      runId,
      undefined
    );
    expect(error).toMatchObject({ name: 'DynamicWorkflowsNotEnabledError' });
    expect((error as Error).message).toContain(
      'Dynamic workflows are not enabled for this project'
    );
  });
});
