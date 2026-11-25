import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import {
  eventsOf,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { notifyParentOfRunCompletion } from '../child-run-completion-notify.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../child-run-completion-notify.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../child-run-completion-notify.js')
  >()),
  notifyParentOfRunCompletion: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(notifyParentOfRunCompletion).mockReset();
  setWorld(undefined);
});

/**
 * A spec 9 run that finishes resumes its parent's completion hook after its
 * terminal write, like the spec 8 engine
 * (`terminal-child-run-completion.test.ts`): the parent reads the child once
 * after registering the hook, so a resume that landed first and found no hook
 * could leave the parent waiting until its safety-net check.
 */
describe.each([
  'node',
  'quickjs',
] as const)('spec 9 terminal writes resume the parent completion hook (%s engine)', (engine) => {
  async function finish(body: string) {
    const { world, runId } = await setupOrchestratorRun(
      `async function workflow() { ${body} }${registerWorkflow()}`,
      [],
      {},
      engine
    );
    // How many terminal events were in the log when the parent was told.
    const terminalAtNotify: number[] = [];
    vi.mocked(notifyParentOfRunCompletion).mockImplementation(async () => {
      terminalAtNotify.push(
        eventsOf(world, 'run_completed').length +
          eventsOf(world, 'run_failed').length
      );
    });
    for (let i = 0; i < 20 && world.held.length > 0; i++) {
      await world.deliver(world.held[0]!);
    }
    return { runId, terminalAtNotify };
  }

  it('after run_completed', async () => {
    const { runId, terminalAtNotify } = await finish(`return 'done';`);

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ runId }),
      'completed'
    );
    expect(terminalAtNotify).toEqual([1]);
  });

  it('after run_failed', async () => {
    vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const { terminalAtNotify } = await finish(
      `throw new Error('child failed');`
    );

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      'failed'
    );
    expect(terminalAtNotify).toEqual([1]);
  });
});
