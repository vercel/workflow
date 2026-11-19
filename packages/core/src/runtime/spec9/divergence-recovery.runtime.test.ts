/**
 * Replay-divergence recovery on a single-orchestrator run: the delivery
 * replays again from a fresh load in a fresh VM, within the same delivery,
 * and fails the run once the recovery budget is spent.
 */
import { RUN_ERROR_CODES } from '@workflow/errors';
import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  orchestratorMessagesOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { getReplayDivergenceMaxRetries } from '../constants.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const TOKEN = 'divergence-hook';

const hookWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const payload = await hook;
    return payload.value;
  }${registerWorkflow()}`;

/** The run's `hook_created`, recorded as if a replay had created another hook. */
const withForeignToken = (event: Event): Event =>
  event.eventType === 'hook_created'
    ? ({
        ...event,
        eventData: { ...dataOf(event), token: 'another-token' },
      } as Event)
    : event;

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe('replay divergence on a single-orchestrator run (node engine)', () => {
  /**
   * A run parked on its hook, with the hook's payload in the log and a wake
   * for it held; `corruptLoads` full loads of the next delivery serve the
   * `hook_created` with another token, which no replay creates.
   */
  async function parkedRun(corruptLoads: number) {
    const setup = await setupOrchestratorRun(hookWorkflow, []);
    const { world, runId } = setup;
    await world.deliver(setup.start);
    const hook = eventsOf(world, 'hook_created')[0];
    expect(hook).toBeDefined();
    world.held.length = 0;
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hook!.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue(
          { value: 'resumed' },
          runId,
          undefined
        ),
      },
    } as Partial<Event>);

    const asWorld = world.asWorld();
    const list = asWorld.events.list.bind(asWorld.events);
    let corrupted = 0;
    asWorld.events.list = async (params) => {
      const page = await list(params);
      if (params.pagination?.cursor || corrupted >= corruptLoads) return page;
      corrupted++;
      return { ...page, data: page.data.map(withForeignToken) };
    };
    setWorld(asWorld);
    await workflowEntrypoint(hookWorkflow)(new Request('https://example.test'));
    const wake = world.enqueue(ORCHESTRATOR_QUEUE, { runId });
    return { world, wake, loads: () => corrupted };
  }

  it('replays again from a fresh load in the same delivery, and reports the recovery on the next natural write', async () => {
    // The run's logger writes its warnings to the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { world, wake, loads } = await parkedRun(1);
    const deliveries = world.deliveries.length;
    const orchestratorCalls = orchestratorMessagesOf(world).length;

    expect(await world.deliver(wake)).toBeUndefined();

    expect(loads()).toBe(1);
    expect(await runResult(world)).toBe('resumed');
    // One delivery, and no message carries the recovery.
    expect(world.deliveries).toHaveLength(deliveries + 1);
    expect(orchestratorMessagesOf(world).slice(orchestratorCalls)).toEqual([]);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('Workflow replay diverged')
      )
    ).toHaveLength(1);
    const completed = world.creates.find(
      (c) => c.event.eventType === 'run_completed'
    );
    expect(completed?.params?.replayDivergenceCount).toBe(1);
  });

  it('fails the run as corrupted once the recovery budget is spent, within the one delivery', async () => {
    const maxRecoveryReplays = getReplayDivergenceMaxRetries();
    const { world, wake, loads } = await parkedRun(Number.POSITIVE_INFINITY);
    const error = vi
      .spyOn(runtimeLogger, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deliveries = world.deliveries.length;

    expect(await world.deliver(wake)).toBeUndefined();

    // Every replay diverged: the first, then one per recovery.
    expect(loads()).toBe(maxRecoveryReplays + 1);
    expect(world.deliveries).toHaveLength(deliveries + 1);
    const failed = world.creates.find(
      (c) => c.event.eventType === 'run_failed'
    );
    expect(dataOf(failed?.event)?.errorCode).toBe(
      RUN_ERROR_CODES.CORRUPTED_EVENT_LOG
    );
    expect(failed?.params?.replayDivergenceCount).toBe(maxRecoveryReplays + 1);
    const logged = error.mock.calls.find(([message]) =>
      String(message).includes('Error while running workflow')
    );
    expect(logged?.[1]).toMatchObject({
      errorCode: RUN_ERROR_CODES.CORRUPTED_EVENT_LOG,
      divergenceCount: maxRecoveryReplays + 1,
      isRecoveryReplay: true,
    });
    expect(
      String((logged?.[1] as { errorMessage?: string }).errorMessage)
    ).toContain(
      `Workflow replay diverged ${maxRecoveryReplays + 1} times after ${maxRecoveryReplays} recovery replays`
    );
  });
});
