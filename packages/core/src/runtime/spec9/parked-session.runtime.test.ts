import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A session-style workflow: one inline step per hook payload. Each payload
// arrives after the delivery that handled the previous one acknowledged, as
// a message does once its orchestrator stopped lingering.

const TOKEN = 'parked-session-hook';
let echoes = 0;
registerStepFunction('ps_echo', async (payload: string) => {
  echoes++;
  return `echo:${payload}`;
});

const sessionWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const replies = [];
    for await (const payload of hook) {
      replies.push(await echo(payload));
      if (replies.length === 3) break;
    }
    return replies;
  }${registerWorkflow()}`;

/** Full loads: an ascending read of the log from its start. */
const fullLoadsOf = (world: AppendOnlyWorld) =>
  world.listCalls.filter((call) => {
    const pagination = call.pagination as
      | { cursor?: string; sortOrder?: string }
      | undefined;
    return pagination?.cursor === undefined && pagination?.sortOrder === 'asc';
  }).length;

async function send(world: AppendOnlyWorld, runId: string, payload: string) {
  world.appendOutOfBand({
    eventType: 'hook_received',
    runId,
    correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
    eventData: {
      token: TOKEN,
      payload: await dehydrateStepReturnValue(payload, runId, undefined),
    },
  } as unknown as Partial<Event>);
  // The unkeyed wake `resumeHook()` sends once its event committed.
  return world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
}

beforeEach(() => {
  echoes = 0;
  // No linger, so every payload reaches a new delivery.
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a session parked across deliveries', () => {
  it('resumes the parked VM on what landed since, without a full load', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);

    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(startLoads);
  });

  it('loads and replays the whole log when another orchestrator wrote in-band meanwhile', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    await send(world, runId, 'a');
    // An overlapping orchestrator elsewhere took an in-band position after
    // this process parked its VM.
    world.seqInBand++;

    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(startLoads + 1);
  });

  it('is never resumed by a second delivery', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    await send(world, runId, 'a');
    // A wake with nothing new acknowledges and leaves the VM parked.
    await world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(startLoads);
  });

  it('keeps no VM on the QuickJS engine', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      [],
      {},
      'quickjs'
    );
    await world.deliver(start);
    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
  });
});
