/**
 * A background step's first-attempt `step_started` carries the step's
 * creation time (`CreateEventParams.stepCreatedAt`), so a World can report
 * creation-to-start latency without reading the log. The orchestrator takes
 * it from the committed `step_created` and puts it on the step's message; a
 * re-sent message carries the creation's time, not the re-send's.
 */
import { RetryableError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import type {
  AppendOnlyWorld,
  HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let flakyAttempts = 0;
registerStepFunction('sca_plain', async () => 'ran');
registerStepFunction('sca_flaky', async () => {
  flakyAttempts++;
  if (flakyAttempts === 1) {
    throw new RetryableError('transient', {
      retryAfter: new Date(Date.now() - 1000),
    });
  }
  return 'retried';
});

const workflowOf = (step: string) =>
  `const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(step)});
  async function workflow() { return await s(); }${registerWorkflow()}`;

const isStepMessage = (held: HeldMessage) =>
  (held.message as { stepId?: string }).stepId !== undefined;

/** The params of each `step_started` create, in order. */
const startParams = (world: AppendOnlyWorld) =>
  world.creates
    .filter(({ event }) => event.eventType === 'step_started')
    .map(({ params }) => params);

const createdAtMs = (world: AppendOnlyWorld): number => {
  const [created] = eventsOf(world, 'step_created') as Event[];
  expect(created).toBeDefined();
  return new Date(created!.createdAt).getTime();
};

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  flakyAttempts = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('stepCreatedAt on a background step (%s engine)', (engine) => {
  it("puts the step_created's createdAt on the message and on the first step_started", async () => {
    const { world, start } = await setupOrchestratorRun(
      workflowOf('sca_plain'),
      [],
      {},
      engine
    );
    await world.deliver(start);
    const createdAt = createdAtMs(world);
    const [message] = stepMessagesOf(world);
    expect((message!.message as { stepCreatedAt?: number }).stepCreatedAt).toBe(
      createdAt
    );

    // The start goes out later than the creation.
    vi.setSystemTime(Date.now() + 2_000);
    await world.deliver(world.held.find(isStepMessage)!);
    expect(startParams(world).map((p) => p?.stepCreatedAt)).toEqual([
      createdAt,
    ]);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe('ran');
  });

  it("carries the creation's time, not the re-send's, on a re-sent message", async () => {
    const { world, start } = await setupOrchestratorRun(
      workflowOf('sca_plain'),
      [],
      {},
      engine
    );
    await world.deliver(start);
    const createdAt = createdAtMs(world);
    // The step's message never got out (the crash window between the commit
    // and the enqueue), and the redelivery comes a minute later.
    world.held.length = 0;
    const sent = stepMessagesOf(world).length;
    vi.setSystemTime(Date.now() + 60_000);
    await world.deliver({ ...start, deliveryCount: 2 });
    const resent = stepMessagesOf(world).slice(sent);
    expect(resent).toHaveLength(1);
    expect(
      (resent[0]!.message as { stepCreatedAt?: number }).stepCreatedAt
    ).toBe(createdAt);

    await world.deliver(world.held.find(isStepMessage)!);
    expect(startParams(world).map((p) => p?.stepCreatedAt)).toEqual([
      createdAt,
    ]);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe('ran');
  });

  it('sends it on the first attempt only', async () => {
    const { world, start } = await setupOrchestratorRun(
      workflowOf('sca_flaky'),
      [],
      {},
      engine
    );
    await world.deliver(start);
    const createdAt = createdAtMs(world);
    // Attempt 1 fails retryably and stays on the message; attempt 2 runs on
    // its redelivery.
    await world.runUntilIdle();
    expect(await runResult(world)).toBe('retried');
    expect(startParams(world).map((p) => p?.stepCreatedAt)).toEqual([
      createdAt,
      undefined,
    ]);
  });

  it('reads it from the log a redelivery loaded when the message has none', async () => {
    const { world, start } = await setupOrchestratorRun(
      workflowOf('sca_plain'),
      [],
      {},
      engine
    );
    await world.deliver(start);
    const createdAt = createdAtMs(world);
    // A message from a runtime that does not send the field, redelivered
    // (so its handler reads the log anyway).
    const held = world.held.find(isStepMessage)!;
    const { stepCreatedAt: _dropped, ...message } = held.message as Record<
      string,
      unknown
    >;
    world.held.splice(world.held.indexOf(held), 1);
    await world.deliver({ ...held, message, deliveryCount: 2 });
    expect(startParams(world).map((p) => p?.stepCreatedAt)).toEqual([
      createdAt,
    ]);
  });
});
