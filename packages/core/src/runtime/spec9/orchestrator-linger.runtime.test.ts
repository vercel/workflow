import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A delivery with nothing left to run stays live while the run waits on a
// hook or a background step (runtime/orchestrator/live-feed.ts,
// `getOrchestratorLingerMs`), so a payload that arrives meanwhile is handled
// by the same invocation instead of a queued wake.

const TOKEN = 'linger-hook';
const hookWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const payload = await hook;
    return payload;
  }${registerWorkflow()}`;

const loopWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const seen = [];
    for await (const payload of hook) {
      seen.push(payload);
      if (seen.length === 2) break;
    }
    return seen;
  }${registerWorkflow()}`;

let flakyFailures = 0;
registerStepFunction('linger_flaky', async () => {
  if (flakyFailures > 0) {
    flakyFailures--;
    throw new Error('transient');
  }
  return 'done';
});
const retryWorkflow = `const flaky = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("linger_flaky");
  async function workflow() { return await flaky(); }${registerWorkflow()}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('orchestrator linger (%s engine)', (engine) => {
  async function start(options: { subscribe?: boolean } = {}) {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    return setupOrchestratorRun(hookWorkflow, [], options, engine);
  }

  async function resume(
    world: Awaited<ReturnType<typeof start>>['world'],
    runId: string
  ) {
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue('late', runId, undefined),
      },
    } as unknown as Partial<Event>);
  }

  it('handles a hook payload that arrives while it lingers in the same delivery', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    const { world, runId, start: message } = await start({ subscribe: true });
    const delivery = world.deliver(message);
    await vi.waitFor(
      () => expect(eventsOf(world, 'hook_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    // Still live: nothing acknowledged yet.
    expect(world.deliveries).toHaveLength(0);
    await resume(world, runId);
    await delivery;

    expect(await runResult(world)).toBe('late');
    expect(world.deliveries).toHaveLength(1);
  });

  // Each pass that finds nothing to run starts the time again, so a run
  // whose events keep coming stays on one delivery for longer than one
  // linger window.
  it('starts the linger time again after every pass', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '300');
    const {
      world,
      runId,
      start: message,
    } = await setupOrchestratorRun(
      loopWorkflow,
      [],
      { subscribe: true },
      engine
    );
    const delivery = world.deliver(message);
    await vi.waitFor(
      () => expect(eventsOf(world, 'hook_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    for (const n of [1, 2]) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      world.appendOutOfBand({
        eventType: 'hook_received',
        runId,
        correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
        eventData: {
          token: TOKEN,
          payload: await dehydrateStepReturnValue(n, runId, undefined),
        },
      } as unknown as Partial<Event>);
    }
    await delivery;

    expect(await runResult(world)).toEqual([1, 2]);
    expect(world.deliveries).toHaveLength(1);
  });

  // A step that ran inline and failed retries from its own message: the
  // lingering delivery takes that message's events as another writer's, not
  // as echoes of its own inline step.
  it('finishes the run when an inline step retries from its own message while it lingers', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    flakyFailures = 1;
    const { world, start: message } = await setupOrchestratorRun(
      retryWorkflow,
      [],
      { subscribe: true },
      engine
    );
    const delivery = world.deliver(message);
    const stepMessage = () =>
      world.held.find(
        (h) => (h.message as { stepId?: string }).stepId !== undefined
      );
    await vi.waitFor(() => expect(stepMessage()).toBeDefined(), {
      timeout: 5000,
    });
    // The retry runs from its own message while the orchestrator lingers,
    // once it is due (the message is redelivered until then).
    while (stepMessage()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await world.deliver(stepMessage()!);
    }
    await delivery;

    expect(await runResult(world)).toBe('done');
    // One orchestrator delivery: the lingering one finished the run.
    expect(
      world.deliveries.filter(
        (d) => (d.message as { stepId?: string }).stepId === undefined
      )
    ).toHaveLength(1);
  });

  it('acknowledges once the linger time passes with nothing new', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '200');
    const { world, start: message } = await start({ subscribe: true });
    const startedAt = Date.now();
    await world.deliver(message);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
  });

  it('does not linger on a World without a live feed', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    const { world, start: message } = await start();
    const startedAt = Date.now();
    await world.deliver(message);

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
  });

  it('does not linger when turned off', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
    const { world, start: message } = await start({ subscribe: true });
    const startedAt = Date.now();
    await world.deliver(message);

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
  });
});
