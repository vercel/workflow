import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FatalError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import {
  dehydrateStepArguments,
  dehydrateWorkflowReturnValue,
} from '../serialization.js';
import { getRun } from './run.js';
import { setWorld } from './world.js';

/**
 * `await run.returnValue` against a run that is already terminal.
 *
 * Inside a workflow the accessor is a step, so whatever it throws is classified
 * by the step handler's retry policy — `FatalError.is(err)` is that gate (see
 * `step-handler.ts`). A terminal run is immutable: once the accessor has
 * *successfully read* one, re-running the body re-reads the same record and
 * throws the same error. Retrying only delays the failure reaching the caller
 * and, once the budget is spent, replaces the error the caller is documented to
 * catch (`WorkflowRunFailedError`) with the retry-exhaustion wrapper.
 *
 * Errors from *failing to read* the run (transport blips,
 * `WorkflowRunNotFoundError` for a resilient start) are a different case and
 * stay retryable.
 *
 * See vercel/workflow#4288.
 */
describe('run.returnValue on a terminal run is not retried', () => {
  let dir: string;
  let world: World;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'returnvalue-terminal-'));
    world = createLocalWorld({ dataDir: dir }) as unknown as World;
    setWorld(world);
  });

  afterEach(async () => {
    setWorld(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  /** A run in `running`, created through the event log like a real one. */
  async function startRun(workflowName: string): Promise<string> {
    const input = await dehydrateStepArguments([], 'run', undefined);
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId: 'dpl_test', workflowName, input },
    });
    const runId = created.run?.runId;
    if (!runId) throw new Error('expected the run to be created');
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    });
    return runId;
  }

  it('throws a non-retryable WorkflowRunFailedError for a failed run', async () => {
    const runId = await startRun('target');
    await world.events.create(runId, {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        error: { message: 'target failed permanently' },
        errorCode: 'USER_ERROR',
      },
    });

    const error = await getRun(runId).returnValue.then(
      () => {
        throw new Error('expected returnValue to reject');
      },
      (err: unknown) => err
    );

    expect(WorkflowRunFailedError.is(error)).toBe(true);
    // The accessor read the run successfully and the run cannot change, so the
    // step fails here rather than burning its retry budget first — and the
    // caller catches the error the docs point it at, not the retry-exhaustion
    // wrapper that replaces it once the budget runs out.
    expect(FatalError.is(error)).toBe(true);
    expect((error as WorkflowRunFailedError).runId).toBe(runId);
    expect((error as WorkflowRunFailedError).cause.message).toBe(
      'target failed permanently'
    );
  }, 30_000);

  it('throws a non-retryable WorkflowRunCancelledError for a cancelled run', async () => {
    const runId = await startRun('target');
    await world.events.create(runId, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    });

    const error = await getRun(runId).returnValue.then(
      () => {
        throw new Error('expected returnValue to reject');
      },
      (err: unknown) => err
    );

    expect(WorkflowRunCancelledError.is(error)).toBe(true);
    expect(FatalError.is(error)).toBe(true);
    expect((error as WorkflowRunCancelledError).runId).toBe(runId);
  }, 30_000);

  it('still resolves normally when the run succeeded', async () => {
    const runId = await startRun('target');
    await world.events.create(runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        output: await dehydrateWorkflowReturnValue('done', runId, undefined),
      },
    });

    await expect(getRun(runId).returnValue).resolves.toBe('done');
  }, 30_000);
});
