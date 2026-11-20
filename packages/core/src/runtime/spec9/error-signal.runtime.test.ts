import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const SECRET = 'Invalid API Key provided: sk_live_do_not_leak';

/** A third-party API error: a class name, an HTTP status, a secret message. */
class StripeAuthenticationError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'StripeAuthenticationError';
  }
}

let attempts = 0;
registerStepFunction(
  'es_charge',
  Object.assign(
    async () => {
      attempts++;
      throw new StripeAuthenticationError(SECRET);
    },
    { maxRetries: 1 }
  )
);

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

const chargeWorkflow = `const charge = ${step('es_charge')};
  async function workflow() { return await charge(); }${registerWorkflow()}`;

const throwingWorkflow = `async function workflow() {
    const error = new TypeError(${JSON.stringify(SECRET)});
    error.status = 503;
    throw error;
  }${registerWorkflow()}`;

/** Everything a failure event carries in plaintext: all but the payload. */
function plaintextOf(event: Event | undefined): Record<string, unknown> {
  const { error: _error, ...rest } = dataOf(event) ?? {};
  return rest;
}

function expectNoSecret(events: Event[]): void {
  for (const event of events) {
    const fields = plaintextOf(event);
    const plaintext = JSON.stringify(fields);
    expect(plaintext).not.toContain('sk_live_do_not_leak');
    expect(plaintext).not.toContain('Invalid API Key');
    expect(plaintext).not.toContain('    at ');
    for (const key of Object.keys(fields)) {
      expect(key).not.toMatch(/^(error)?(message|stack)$/i);
    }
  }
}

afterEach(() => {
  setWorld(undefined);
  attempts = 0;
});

describe.each([
  'node',
  'quickjs',
] as const)('failure events carry the error class name and status (%s engine)', (engine) => {
  it('on step_retrying, step_failed and the run_failed of a step that ran out of retries', async () => {
    // The retry is backed off by a second: advance the clock to it.
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    onTestFinished(() => nowSpy.mockRestore());
    const { world, start } = await setupOrchestratorRun(
      chargeWorkflow,
      [],
      {
        advanceClock: (seconds) => {
          offsetMs += seconds * 1000;
        },
      },
      engine
    );
    await world.deliver(start);
    await world.runUntilIdle(30);

    expect(attempts).toBe(2);
    const retrying = eventsOf(world, 'step_retrying');
    const stepFailed = eventsOf(world, 'step_failed');
    const runFailed = eventsOf(world, 'run_failed');
    expect(retrying).toHaveLength(1);
    expect(stepFailed).toHaveLength(1);
    expect(runFailed).toHaveLength(1);
    const signal = { errorName: 'StripeAuthenticationError', errorStatus: 401 };
    expect(plaintextOf(retrying[0])).toMatchObject(signal);
    expect(plaintextOf(stepFailed[0])).toMatchObject(signal);
    // The run failed with the step's error as the workflow saw it: the
    // SDK's retry-exhaustion FatalError around the hydrated original, so the
    // name is the original's. Its `statusCode` is an own property that error
    // serialization does not carry into the workflow, so the run's event has
    // no status; the step's events, written beside the live error, do.
    expect(plaintextOf(runFailed[0])).toEqual({
      errorCode: 'USER_ERROR',
      errorName: 'StripeAuthenticationError',
    });
    expectNoSecret([...retrying, ...stepFailed, ...runFailed]);
  });

  it('on the run_failed of an error the workflow threw', async () => {
    const { world, start } = await setupOrchestratorRun(
      throwingWorkflow,
      [],
      {},
      engine
    );
    await world.deliver(start);
    await world.runUntilIdle();

    const runFailed = eventsOf(world, 'run_failed');
    expect(runFailed).toHaveLength(1);
    // The node engine fails the run with the live error. QuickJS serializes
    // it out of the VM first, which keeps its class name but not its own
    // `status` property.
    expect(plaintextOf(runFailed[0])).toEqual({
      errorCode: 'USER_ERROR',
      errorName: 'TypeError',
      ...(engine === 'node' ? { errorStatus: 503 } : {}),
    });
    expectNoSecret(runFailed);
  });
});
