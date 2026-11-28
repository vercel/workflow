import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

/** The inline budget of the invocation under test. */
const INLINE_BUDGET_MS = 1_000;
/** How long a hung step waits for its signal before giving up on it. */
const HANG_LIMIT_MS = 6_000;

let bodyEntered = withResolvers<void>();
/** When `idl_after` ran, one entry per run of its body. */
const startedAfterSlow: number[] = [];
/** What the hung step saw of its signal. */
let observed: { aborted: boolean; reason: unknown } | undefined;

registerStepFunction('idl_hang', async (signal: AbortSignal) => {
  bodyEntered.resolve();
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, HANG_LIMIT_MS);
  });
  observed = { aborted: signal.aborted, reason: signal.reason };
  return 'step';
});

registerStepFunction('idl_slow', async () => {
  bodyEntered.resolve();
  await new Promise<void>((resolve) =>
    setTimeout(resolve, INLINE_BUDGET_MS * 2)
  );
  return 'slow';
});

// A hook wins a race against an inline step that only ends when it is
// aborted; the workflow aborts the loser and returns.
const hungStepWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const hang = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("idl_hang");
  async function workflow() {
    const controller = new AbortController();
    const hook = createHook({ token: "idl-hook" });
    const winner = await Promise.race([
      hook.then(() => "hook"),
      hang(controller.signal),
    ]);
    controller.abort("hook resumed");
    return winner;
  }${registerWorkflow()}`;

registerStepFunction('idl_after', async () => {
  startedAfterSlow.push(Date.now());
  return 'after';
});

// The second step is created only once the first is done, past the budget.
const slowStepWorkflow = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("idl_slow");
  const after = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("idl_after");
  async function workflow() {
    return (await slow()) + "+" + (await after());
  }${registerWorkflow()}`;

beforeEach(() => {
  bodyEntered = withResolvers<void>();
  observed = undefined;
  startedAfterSlow.length = 0;
  vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', String(INLINE_BUDGET_MS));
  vi.stubEnv('WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS', '0');
});

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('an invocation past its inline budget (%s engine)', (engine) => {
  it('keeps replaying while an inline step is in flight, so an event after the budget reaches the workflow', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      hungStepWorkflow,
      [],
      {},
      engine
    );

    const startedAt = Date.now();
    const delivery = world.deliver(start);
    await bodyEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, INLINE_BUDGET_MS * 1.5));
    const hook = eventsOf(world, 'hook_created').find(
      (event) => dataOf(event)?.token === 'idl-hook'
    );
    if (!hook) throw new Error('expected the racing hook to be created');
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hook.correlationId,
      eventData: {
        token: dataOf(hook)?.token,
        payload: await dehydrateStepReturnValue('payload', runId, undefined),
      },
    } as Partial<Event>);
    await delivery;
    await world.runUntilIdle();

    // The workflow saw the hook and aborted the step in this invocation,
    // rather than the step running out its limit with the run deaf to events.
    expect(observed).toEqual({ aborted: true, reason: 'hook resumed' });
    expect(Date.now() - startedAt).toBeLessThan(HANG_LIMIT_MS);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe('hook');
  });

  it('hands the run to the next delivery once a step that outlasted the budget finishes', async () => {
    const { world, start } = await setupOrchestratorRun(
      slowStepWorkflow,
      [],
      {},
      engine
    );

    const delivery = world.deliver(start);
    await bodyEntered.promise;
    await delivery;
    // The first delivery ended when the slow step finished past the budget,
    // before the workflow's next step ran; a wake continues the run.
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    expect(startedAfterSlow).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);

    await world.runUntilIdle();
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe('slow+after');
  });
});
