import { type Event, SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import {
  hasOtherPendingStep,
  WAKE_COALESCE_MARGIN_SECONDS,
  WAKE_COALESCE_WINDOW_MS,
  wakeAfterCompletion,
} from '../step-handler.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('sw_fast', async (n: number) => n + 1);
let releaseSlow: (() => void) | undefined;
registerStepFunction('sw_slow', async () => {
  await new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  return 'slow';
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

const FAN_OUT = 64;
const fanOut = `const fast = ${step('sw_fast')};
  async function workflow(n) {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => fast(i)));
    return results.length;
  }${registerWorkflow()}`;

const race = `const fast = ${step('sw_fast')}; const slow = ${step('sw_slow')};
  async function workflow() {
    return await Promise.race([fast(1), slow()]);
  }${registerWorkflow()}`;

const isStepMessage = (message: unknown) =>
  (message as { stepId?: string }).stepId !== undefined;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  releaseSlow = undefined;
});

describe.each([
  'node',
  'quickjs',
] as const)('orchestrator wakes after background steps (%s engine)', (engine) => {
  it('wakes a background fan-out a constant number of times, not once per step', async () => {
    // One coalescing window for the whole test.
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_500);
    const { world } = await setupOrchestratorRun(fanOut, [FAN_OUT], {}, engine);
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT);
    const orchestratorDeliveries = world.deliveries.filter(
      (delivery) => !isStepMessage(delivery.message)
    );
    // The start, the window's shared wake, and the last step's own wake.
    expect(orchestratorDeliveries.length).toBeLessThanOrEqual(3);
    const keyed = world.queueCalls.filter(
      (call) =>
        !isStepMessage(call.message) && call.opts?.idempotencyKey !== undefined
    );
    // Every completion but the last joined one key.
    expect(new Set(keyed.map((call) => call.opts?.idempotencyKey)).size).toBe(
      1
    );
    expect(keyed.length).toBe(FAN_OUT - 1);
  });

  it('still wakes a race that one branch decides while the other is pending', async () => {
    const { world } = await setupOrchestratorRun(race, [], {}, engine);
    await world.deliver(world.held[0]!);
    const fastMessage = world.held.find(
      (held) => (held.message as { stepName?: string }).stepName === 'sw_fast'
    );
    expect(fastMessage).toBeDefined();
    await world.deliver(fastMessage!);
    // The slow step is still pending, so the fast one sent the shared wake.
    const wake = world.held.find(
      (held) =>
        !isStepMessage(held.message) && held.opts?.idempotencyKey !== undefined
    );
    expect(wake?.opts?.delaySeconds).toBeGreaterThan(0);
    await world.deliver(wake!);
    expect(await runResult(world)).toBe(2);
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    releaseSlow?.();
  });
});

describe('wakeAfterCompletion', () => {
  const created = (id: string) =>
    ({ eventType: 'step_created', correlationId: id }) as Event;
  const completed = (id: string) =>
    ({ eventType: 'step_completed', correlationId: id }) as Event;

  it('counts only other steps without an outcome as pending', () => {
    expect(hasOtherPendingStep([created('a'), completed('a')], 'a')).toBe(
      false
    );
    expect(hasOtherPendingStep([created('a'), created('b')], 'a')).toBe(true);
    expect(
      hasOtherPendingStep(
        [created('a'), created('b'), completed('b'), completed('a')],
        'a'
      )
    ).toBe(false);
  });

  // The bound that lets completions share a wake: whichever completion of a
  // window sends the key first, its message is delivered after the last
  // completion of that window sent its own.
  it('delivers a window shared wake after every completion of the window', async () => {
    const sends: { at: number; key: unknown; delaySeconds: number }[] = [];
    const world = {
      specVersion: SPEC_VERSION_CURRENT,
      queue: async (_name: string, _message: unknown, opts: never) => {
        const { idempotencyKey, delaySeconds } = opts as {
          idempotencyKey: unknown;
          delaySeconds: number;
        };
        sends.push({ at: now, key: idempotencyKey, delaySeconds });
        return { messageId: 'msg' };
      },
      events: {
        list: async () => ({
          data: [created('a'), created('b'), completed('a')].map(
            (event, index) => ({
              ...event,
              runId: 'wrun_x',
              eventId: `evnt_${index + 1}`,
              createdAt: new Date(),
            })
          ),
          cursor: null,
          hasMore: false,
          snapshot: { seq: 3, seqInBand: 1 },
        }),
      },
    } as unknown as World;
    setWorld(world);
    const ctx = {
      world,
      runId: 'wrun_x',
      workflowName: 'workflow',
      namespace: undefined,
      nextTraceCarrier: async () => ({}),
    };
    const windowStart = 1_791_000_000_000;
    let now = 0;
    for (const offset of [
      0,
      1,
      WAKE_COALESCE_WINDOW_MS / 2,
      WAKE_COALESCE_WINDOW_MS - 1,
    ]) {
      now = windowStart + offset;
      await wakeAfterCompletion(ctx, 'a', () => now);
    }
    expect(new Set(sends.map((s) => s.key)).size).toBe(1);
    const lastSendAt = Math.max(...sends.map((s) => s.at));
    for (const send of sends) {
      // Whichever of them a queue keeps, it is delivered after the last send,
      // with the margin to spare for clock skew between senders.
      expect(send.at + send.delaySeconds * 1000).toBeGreaterThanOrEqual(
        lastSendAt + WAKE_COALESCE_MARGIN_SECONDS * 1000
      );
    }
  });
});
