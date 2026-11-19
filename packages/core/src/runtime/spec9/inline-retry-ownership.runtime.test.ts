import { RetryableError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  dataOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
// The orchestrator and the step's own message on two instances: the
// in-process single-flight would make the second body a loser, and nothing
// dedupes across instances.
vi.mock('./step-single-flight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./step-single-flight.js')>()),
  runStepSingleFlight: (
    _runId: string,
    _correlationId: string,
    execute: () => Promise<unknown>
  ) => execute(),
}));

// An inline step whose first attempt fails retries on its own message, which
// runs every later attempt. A wake that reaches the orchestrator while that
// attempt runs must not run the step inline again.

/** Which body ran, in order. */
let bodies: string[] = [];
let attempts = 0;
let release = withResolvers<void>();
let running = withResolvers<void>();
registerStepFunction('iro_flaky', async () => {
  attempts++;
  if (attempts === 1) {
    bodies.push('flaky:inline');
    throw new RetryableError('transient', {
      retryAfter: new Date(Date.now() - 1000),
    });
  }
  const attempt = attempts;
  bodies.push(`flaky:${attempt}`);
  if (attempt === 2) {
    running.resolve();
    await release.promise;
  }
  return `attempt ${attempt}`;
});
registerStepFunction('iro_other', async () => {
  bodies.push('other');
  return 'other';
});

const code = `const flaky = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("iro_flaky");
  const other = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("iro_other");
  async function workflow() {
    const [a, b] = await Promise.all([flaky(), other()]);
    return a + "/" + b;
  }${registerWorkflow()}`;

const stepIdOf = (held: { message: unknown }) =>
  (held.message as { stepId?: string }).stepId;

beforeEach(() => {
  bodies = [];
  attempts = 0;
  release = withResolvers<void>();
  running = withResolvers<void>();
  // One inline step: the other step runs on its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('an inline step retried on its own message (%s engine)', (engine) => {
  it('is not run inline again while its own message runs a later attempt', async () => {
    const { world, start } = await setupOrchestratorRun(code, [], {}, engine);
    await world.deliver(start);
    const retrying = world.events.find((e) => e.eventType === 'step_retrying');
    expect(retrying).toBeDefined();
    const flakyId = retrying!.correlationId;
    const own = world.held.find((held) => stepIdOf(held) === flakyId);
    const otherMessage = world.held.find(
      (held) => stepIdOf(held) !== undefined && stepIdOf(held) !== flakyId
    );
    expect(own).toBeDefined();
    expect(otherMessage).toBeDefined();

    // The retry's attempt starts on its own message and keeps running.
    const ownDelivery = world.deliver(own!);
    await running.promise;
    // The other step completes and wakes the orchestrator, which replays a
    // log holding the retry's `step_started`.
    await world.deliver(otherMessage!);
    for (;;) {
      const wake = world.held.find((held) => stepIdOf(held) === undefined);
      if (!wake) break;
      await world.deliver(wake);
    }
    expect(bodies).toEqual(['flaky:inline', 'flaky:2', 'other']);
    expect(world.events.some((e) => e.eventType === 'run_completed')).toBe(
      false
    );

    release.resolve();
    await ownDelivery;
    await world.runUntilIdle();
    expect(bodies).toEqual(['flaky:inline', 'flaky:2', 'other']);
    expect(await runResult(world)).toBe('attempt 2/other');
    expect(
      world.events
        .filter(
          (e) => e.eventType === 'step_started' && e.correlationId === flakyId
        )
        .map((e) => dataOf(e)?.attempt)
    ).toEqual([1, 2]);
  });
});
