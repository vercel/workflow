import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A delivery that throws from inside its loop (here a failed `wait_completed`
// write while an inline body runs) still stops its live feed: no log-tail
// poll runs after the delivery has ended.

const BODY_MS = 1_000;
registerStepFunction('feed_after_throw_slow', async () => {
  await new Promise((resolve) => setTimeout(resolve, BODY_MS));
  return 'ok';
});
const code = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("feed_after_throw_slow");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    await Promise.all([slow(), sleep("${BODY_MS / 2}ms")]);
    return 'done';
  }${registerWorkflow()}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('live feed after a throw (%s engine)', (engine) => {
  it('makes no events.list call after the delivery rejects', async () => {
    const pollMs = 50;
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', String(pollMs));
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
    let refused = 0;
    const { world, start } = await setupOrchestratorRun(
      code,
      [],
      {
        beforeCreate: (data) => {
          if (data.eventType === 'wait_completed') {
            refused++;
            throw Object.assign(new Error('injected failure'), {
              status: 500,
            });
          }
        },
      },
      engine
    );
    await expect(world.deliver(start)).rejects.toThrow('injected failure');
    expect(refused).toBe(1);
    // The inline body settled before the delivery ended.
    const listsAtExit = world.listCalls.length;
    await new Promise((resolve) => setTimeout(resolve, pollMs * 10));
    expect(world.listCalls.length).toBe(listsAtExit);
  }, 20_000);
});
