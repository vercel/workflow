import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepArguments } from '../../serialization.js';
import { setWorld } from '../world.js';
import { SPEC8_EVENT_SPEC_VERSION } from './constants.js';
import { executeStep } from './step-executor.js';

/** A third-party API error: a class name, an HTTP status, a secret message. */
class StripeAuthenticationError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'StripeAuthenticationError';
  }
}

const SECRET = 'Invalid API Key provided: sk_live_do_not_leak';

let counter = 0;

async function setup(body: () => Promise<unknown>, maxRetries: number) {
  counter += 1;
  const world: World = createWorld({
    dataDir: mkdtempSync(join(tmpdir(), 'wf-step-error-signal-')),
    tag: `signal${counter}`,
  });
  setWorld(world);
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC8_EVENT_SPEC_VERSION,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'wf',
      input: await dehydrateStepArguments([], 'run', undefined),
    },
  });
  const runId = created.run?.runId as string;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC8_EVENT_SPEC_VERSION,
    eventData: {},
  } as never);
  const stepId = `step_signal_${counter}`;
  const stepName = `step//./step-error-signal-test//signalStep${counter}`;
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC8_EVENT_SPEC_VERSION,
    correlationId: stepId,
    eventData: {
      stepName,
      input: await dehydrateStepArguments(
        { args: [], closureVars: undefined, thisVal: undefined },
        runId,
        undefined
      ),
    },
  });
  registerStepFunction(stepName, Object.assign(body, { maxRetries }));
  const run = (attempt: number) =>
    executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: attempt,
    });
  const events = async (eventType: Event['eventType']) =>
    (await world.events.list({ runId })).data.filter(
      (e) => e.eventType === eventType && e.correlationId === stepId
    );
  return { run, events };
}

/** Everything a failure event carries in plaintext: all but the payload. */
function plaintextOf(event: Event): Record<string, unknown> {
  const { error: _error, ...rest } = (event as { eventData: object })
    .eventData as Record<string, unknown>;
  return rest;
}

describe('step failure events carry the error class name and status', () => {
  afterEach(() => {
    setWorld(undefined);
  });

  it('records them on step_retrying, and on the step_failed that ends the retries', async () => {
    const { run, events } = await setup(async () => {
      throw new StripeAuthenticationError(SECRET);
    }, 1);

    await expect(run(1)).resolves.toMatchObject({ type: 'retry' });
    const [retrying] = await events('step_retrying');
    expect(plaintextOf(retrying)).toMatchObject({
      errorName: 'StripeAuthenticationError',
      errorStatus: 401,
    });

    await expect(run(2)).resolves.toMatchObject({ type: 'failed' });
    // The SDK wraps the last error in a FatalError when the retries run out;
    // the plaintext fields still name the error the step threw.
    const [failed] = await events('step_failed');
    expect(plaintextOf(failed)).toMatchObject({
      errorName: 'StripeAuthenticationError',
      errorStatus: 401,
    });

    for (const event of [retrying, failed]) {
      const fields = plaintextOf(event);
      const plaintext = JSON.stringify(fields);
      expect(plaintext).not.toContain('sk_live_do_not_leak');
      expect(plaintext).not.toContain('Invalid API Key');
      expect(plaintext).not.toContain('    at ');
      for (const key of Object.keys(fields)) {
        expect(key).not.toMatch(/^(error)?(message|stack)$/i);
      }
    }
  });

  it('records a FatalError as itself, with no status', async () => {
    const { run, events } = await setup(async () => {
      throw new FatalError(SECRET);
    }, 3);

    await expect(run(1)).resolves.toMatchObject({ type: 'failed' });
    expect(await events('step_retrying')).toHaveLength(0);
    const [failed] = await events('step_failed');
    expect(plaintextOf(failed)).toMatchObject({ errorName: 'FatalError' });
    expect(plaintextOf(failed)).not.toHaveProperty('errorStatus');
    expect(JSON.stringify(plaintextOf(failed))).not.toContain('sk_live');
  });

  it('records only the wrapping FatalError for a thrown non-error', async () => {
    // A thrown string has no class name; what failed the step is the SDK's
    // retry-exhaustion FatalError around it.
    const { run, events } = await setup(async () => {
      throw SECRET;
    }, 0);

    await expect(run(1)).resolves.toMatchObject({ type: 'failed' });
    const [failed] = await events('step_failed');
    expect(plaintextOf(failed)).toMatchObject({ errorName: 'FatalError' });
    expect(plaintextOf(failed)).not.toHaveProperty('errorStatus');
    expect(JSON.stringify(plaintextOf(failed))).not.toContain('sk_live');
  });
});
