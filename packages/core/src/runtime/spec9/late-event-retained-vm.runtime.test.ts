import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import * as quickjsRuntime from '../quickjs-runtime.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const TOKEN = 'late-retained-hook';
registerStepFunction(
  'late_retained_step',
  async (payload: number) => payload * 10
);
const code = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const handle = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("late_retained_step");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const seen = [];
    for await (const payload of hook) {
      seen.push(await handle(payload));
      if (seen.length === 2) break;
    }
    return seen;
  }${registerWorkflow()}`;

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('late hook event on retained VM (%s engine)', (engine) => {
  it('handles both payloads in one delivery without a cold replay', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    const debug = vi.spyOn(runtimeLogger, 'debug');
    const quickjsStarts = vi.spyOn(quickjsRuntime, 'startQuickJSWorkflow');
    const { world, runId, start } = await setupOrchestratorRun(
      code,
      [],
      { subscribe: true },
      engine
    );
    const appendPayload = async (payload: number) => {
      world.appendOutOfBand({
        eventType: 'hook_received',
        runId,
        correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
        eventData: {
          token: TOKEN,
          payload: await dehydrateStepReturnValue(payload, runId, undefined),
        },
      } as unknown as Partial<Event>);
    };
    let injected = false;
    const asWorld = world.asWorld();
    if (engine === 'node') {
      // The tail read after the step is where the suspended VM learns of
      // events that landed above the pass it already consumed.
      const list = asWorld.events.list.bind(asWorld.events);
      asWorld.events.list = async (params) => {
        if (
          !injected &&
          params.pagination?.cursor !== undefined &&
          eventsOf(world, 'step_completed').length === 1
        ) {
          injected = true;
          await appendPayload(2);
        }
        return list(params);
      };
    } else {
      const create = asWorld.events.create.bind(asWorld.events);
      asWorld.events.create = (async (...args: Parameters<typeof create>) => {
        const result = await create(...args);
        if (!injected && args[1].eventType === 'step_completed') {
          injected = true;
          await appendPayload(2);
        }
        return result;
      }) as typeof create;
    }
    setWorld(asWorld);

    const delivery = world.deliver(start);
    await vi.waitFor(
      () => expect(eventsOf(world, 'hook_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    await appendPayload(1);
    await delivery;

    expect(injected).toBe(true);
    expect(await runResult(world)).toEqual([10, 20]);
    expect(world.deliveries).toHaveLength(1);
    const modes = debug.mock.calls
      .filter(([message]) => message === 'Starting workflow execution')
      .map(([, fields]) => (fields as { executionMode: string }).executionMode);
    if (engine === 'node') {
      expect(modes[0]).toBe('replay');
      expect(modes.slice(1)).toContain('retained');
      expect(modes.slice(1).every((mode) => mode === 'retained')).toBe(true);
    } else {
      expect(quickjsStarts).toHaveBeenCalledTimes(1);
    }
  });
});
