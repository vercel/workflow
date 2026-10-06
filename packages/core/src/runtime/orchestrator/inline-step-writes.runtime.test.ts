import { ThrottleError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  orchestratorMessagesOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const calls: Record<string, number> = {};
const count = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};
let failuresLeft = 0;
let bodyEntered = withResolvers<void>();
let bodyGate = withResolvers<void>();

registerStepFunction('iw_a', async () => {
  count('iw_a');
  return 1;
});
registerStepFunction('iw_b', async () => {
  count('iw_b');
  return 2;
});
registerStepFunction('iw_flaky', async () => {
  count('iw_flaky');
  if (failuresLeft > 0) {
    failuresLeft--;
    throw new Error('transient');
  }
  return 3;
});
registerStepFunction('iw_gated', async () => {
  count('iw_gated');
  bodyEntered.resolve();
  await bodyGate.promise;
  return 'step';
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

const oneStepWorkflow = `const a = ${step('iw_a')};
  async function workflow() { return await a(); }${registerWorkflow()}`;

const threeStepWorkflow = `const a = ${step('iw_a')}; const b = ${step('iw_b')};
  const flaky = ${step('iw_flaky')};
  async function workflow() {
    const [x, y, z] = await Promise.all([a(), b(), flaky()]);
    return x + y + z;
  }${registerWorkflow()}`;

// A hook payload races an inline step body; whichever the log holds first
// wins.
const hookRaceWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const gated = ${step('iw_gated')};
  async function workflow() {
    const hook = createHook({ token: "iw-race-hook" });
    return await Promise.race([hook.then(() => "hook"), gated()]);
  }${registerWorkflow()}`;

/**
 * Refuses the first `step_started` of each listed step with a 429, as a
 * loaded World does. The refusal allocates nothing.
 */
function throttleFirstStart(
  world: AppendOnlyWorld,
  code: string,
  retryAfterByStep: Record<string, number>
) {
  const asWorld = world.asWorld();
  const create = asWorld.events.create.bind(asWorld.events);
  const throttled = new Set<string>();
  asWorld.events.create = (async (...args: Parameters<typeof create>) => {
    const data = args[1] as {
      eventType: string;
      eventData?: { stepName?: string };
    };
    const stepName = data.eventData?.stepName;
    if (
      data.eventType === 'step_started' &&
      stepName !== undefined &&
      retryAfterByStep[stepName] !== undefined &&
      !throttled.has(stepName)
    ) {
      throttled.add(stepName);
      throw new ThrottleError('throttled', {
        retryAfter: retryAfterByStep[stepName],
      });
    }
    return create(...args);
  }) as typeof create;
  setWorld(asWorld);
  return workflowEntrypoint(code)(new Request('https://example.test'));
}

/** The delay the first orchestrator delivery deferred the run by. */
function deferral(world: AppendOnlyWorld): number | undefined {
  const result = world.deliveries[0]?.result as
    | { timeoutSeconds?: number }
    | undefined;
  if (result?.timeoutSeconds !== undefined) return result.timeoutSeconds;
  const delays = orchestratorMessagesOf(world)
    .map((call) => call.opts?.delaySeconds as number | undefined)
    .filter((d): d is number => d !== undefined);
  return delays.length > 0 ? Math.max(...delays) : undefined;
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  failuresLeft = 0;
  bodyEntered = withResolvers<void>();
  bodyGate = withResolvers<void>();
});

afterEach(() => {
  bodyGate.resolve();
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('inline step writes (%s engine)', (engine) => {
  // The deferred replay finds the step's `step_created` (inline, never
  // started) and runs the step inline.
  it('defers the run instead of queueing a throttled inline step, and runs it inline afterwards', async () => {
    const { world, start } = await setupOrchestratorRun(
      oneStepWorkflow,
      [],
      {},
      engine
    );
    await throttleFirstStart(world, oneStepWorkflow, { iw_a: 5 });

    await world.deliver(start);
    // The start was refused: no body, no step message, and the run comes
    // back after the backoff.
    expect(calls.iw_a).toBeUndefined();
    expect(stepMessagesOf(world)).toEqual([]);
    expect(deferral(world)).toBe(5);

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1);
    expect(calls.iw_a).toBe(1);
    expect(eventsOf(world, 'step_created')).toHaveLength(1);
    expect(dataOf(eventsOf(world, 'step_created')[0])?.inline).toBe(true);
    expect(
      eventsOf(world, 'step_started').map((e) => dataOf(e)?.attempt)
    ).toEqual([1]);
    expect(stepMessagesOf(world)).toEqual([]);
  });

  // Every settled sibling is acted on before the deferral: the longest
  // backoff (9s) wins, and the failed sibling's retry message goes out now.
  it('defers by the longest backoff and queues a sibling retry in the same delivery', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
    failuresLeft = 1;
    const { world, start } = await setupOrchestratorRun(
      threeStepWorkflow,
      [],
      {},
      engine
    );
    await throttleFirstStart(world, threeStepWorkflow, { iw_a: 3, iw_b: 9 });

    await world.deliver(start);
    expect(calls.iw_a).toBeUndefined();
    expect(calls.iw_b).toBeUndefined();
    expect(calls.iw_flaky).toBe(1);
    // The failed step exists and started, so its retry gets its own message.
    expect(
      stepMessagesOf(world).map(
        (call) => (call.message as { stepName?: string }).stepName
      )
    ).toEqual(['iw_flaky']);
    expect(deferral(world)).toBe(9);
  });

  it('finishes a run whose inline steps were throttled beside a retrying sibling', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
    failuresLeft = 1;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const { world } = await setupOrchestratorRun(
        threeStepWorkflow,
        [],
        {
          advanceClock: (seconds) => {
            offsetMs += seconds * 1000;
          },
        },
        engine
      );
      await throttleFirstStart(world, threeStepWorkflow, {
        iw_a: 3,
        iw_b: 9,
      });
      await world.runUntilIdle(30);

      expect(await runResult(world)).toBe(6);
      expect(calls).toEqual({ iw_a: 1, iw_b: 1, iw_flaky: 2 });
      // The retry ran in the background, on one message.
      expect(
        new Set(stepMessagesOf(world).map((c) => c.opts?.idempotencyKey)).size
      ).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A redelivery finds the inline step created and started with no outcome,
  // and runs it inline again as a redelivery attempt.
  it('runs an inline step again when the delivery that started it died before the outcome', async () => {
    const { world, start } = await setupOrchestratorRun(
      oneStepWorkflow,
      [],
      {},
      engine
    );
    // The first delivery dies inside the body: its outcome write never
    // happens, and the queue redelivers the same message.
    const asWorld = world.asWorld();
    const create = asWorld.events.create.bind(asWorld.events);
    let died = false;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      if (!died && args[1].eventType === 'step_completed') {
        died = true;
        throw new Error('invocation died');
      }
      return create(...args);
    }) as typeof create;
    setWorld(asWorld);
    await workflowEntrypoint(oneStepWorkflow)(
      new Request('https://example.test')
    );
    await world.deliver(start).catch(() => {});
    expect(eventsOf(world, 'step_started')).toHaveLength(1);
    expect(eventsOf(world, 'step_completed')).toHaveLength(0);
    if (!world.held.some((h) => h.messageId === start.messageId)) {
      world.held.push({ ...start, deliveryCount: 2 });
    }

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1);
    expect(calls.iw_a).toBe(2);
    expect(
      eventsOf(world, 'step_started').map((e) => dataOf(e)?.startReason)
    ).toEqual(['first', 'redelivery']);
    expect(stepMessagesOf(world)).toEqual([]);
  });

  it('feeds an out-of-band event that landed below an inline outcome before the outcome', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      hookRaceWorkflow,
      [],
      {},
      engine
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    const delivery = world.deliver(start);
    await bodyEntered.promise;
    // The hook payload commits while the body runs, so it sits below the
    // step's outcome in the log.
    const hookCreated = eventsOf(world, 'hook_created')[0]!;
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hookCreated.correlationId,
      eventData: {
        token: dataOf(hookCreated)?.token,
        payload: await dehydrateStepReturnValue('payload', runId, undefined),
      },
    } as Partial<Event>);
    bodyGate.resolve();
    await delivery;
    await world.runUntilIdle();

    // The step outcome's write named the delivery's position, and its
    // skipped-slot report carried the hook payload, which the workflow
    // consumed first, as every later replay does.
    const outcome = world.creates.find(
      (c) => c.event.eventType === 'step_completed'
    );
    expect(outcome?.params).toMatchObject({
      inBand: true,
      eventCount: expect.any(Number),
    });
    expect(await runResult(world)).toBe('hook');
    expect(calls.iw_gated).toBe(1);
  });
});
