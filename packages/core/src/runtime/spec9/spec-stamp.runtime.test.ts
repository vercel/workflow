import { messageRunSpecVersion, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import {
  RUN_SPEC_VERSION_CACHE_SIZE,
  rememberRunSpecVersion,
} from '../run-spec-routing.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('ss_add', async (a: number, b: number) => {
  // The step's own wake goes out after its body: forget the run here.
  evictRememberedSpecs();
  return a + b;
});

const workflowCode = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ss_add");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const a = await add(1, 2);
    await sleep("1h");
    const b = await add(a, 3);
    return b;
  }${registerWorkflow()}`;

/** Fills this process's run spec memory with other runs, evicting `runId`. */
function evictRememberedSpecs(): void {
  const prefix = `wrun_other_${Math.random().toString(36).slice(2)}_`;
  for (let i = 0; i < RUN_SPEC_VERSION_CACHE_SIZE; i++) {
    rememberRunSpecVersion(`${prefix}${i}`, SPEC_VERSION_CURRENT);
  }
}

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message, so step invocations wake the run.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('spec stamps on a spec 9 run after the process forgot its spec (%s engine)', (engine) => {
  it('stamps every message it sends with the run spec version', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Every delivery remembers the run's spec version as it routes the
    // message. Forgetting it before every write (and in every step body)
    // leaves a message stamped only if its sender names the version.
    const { world } = await setupOrchestratorRun(
      workflowCode,
      [],
      { beforeCreate: () => evictRememberedSpecs() },
      engine
    );
    const before = world.queueCalls.length;
    for (let i = 0; i < 20 && world.held.length > 0; i++) {
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      await world.deliver(world.held[0]!);
    }
    expect(await runResult(world)).toBe(6);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);

    const sent = world.queueCalls.slice(before);
    // Step outcomes woke the run, and on the node engine the sleep armed a
    // timer. (The QuickJS replay clock trails the faked Date here, so its
    // sleep's resumeAt is already past when it is created, and the delivery
    // completes it without a timer.)
    expect(
      sent.some((call) => (call.message as { stepId?: string }).stepId)
    ).toBe(true);
    expect(
      sent.some(
        (call) =>
          (call.message as { waitContinuation?: unknown }).waitContinuation
      )
    ).toBe(engine === 'node');
    expect(
      sent.some(
        (call) =>
          !(call.message as { stepId?: string }).stepId &&
          !(call.message as { waitContinuation?: unknown }).waitContinuation
      )
    ).toBe(true);
    for (const call of sent) {
      expect(messageRunSpecVersion(call.message)).toBe(SPEC_VERSION_CURRENT);
    }
  });
});
