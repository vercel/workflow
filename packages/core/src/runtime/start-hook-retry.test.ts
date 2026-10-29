/**
 * A step that calls `start({ hook })`, gets an uncertain outcome, and retries:
 * the token makes the retry safe, so the run ends with exactly one owner.
 * Runs against world-local's real storage, with the admission's response
 * lost after it committed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FatalError,
  HookConflictError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../step/context-storage.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const workflow = { workflowId: 'workflow//./test//orders' };
const TOKEN = 'order:retry';

/** One attempt of the `start()` step, as the step executor runs it. */
const stepAttempt = <T>(attempt: number, fn: () => Promise<T>) =>
  contextStorage.run(
    {
      stepMetadata: {
        stepName: 'start',
        stepId: 'step_1',
        stepStartedAt: new Date(),
        attempt,
      },
      workflowMetadata: {
        workflowName: 'parent',
        workflowRunId: 'wrun_parent',
        workflowStartedAt: new Date(),
        url: 'http://localhost:3000',
        features: { encryption: false },
      },
      ops: [],
    } as any,
    fn
  );

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'start-hook-retry-'));
});

afterEach(async () => {
  setWorld(undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a step retrying start({ hook })', () => {
  /** world-local, losing the first `lose` `run_created` responses. */
  function lossyWorld(lose: number) {
    const local = createLocalWorld({ dataDir: dir });
    let lost = 0;
    const queue = vi.fn(async () => ({ messageId: null }));
    const create = vi.fn((async (runId: any, data: any, params: any) => {
      const result = await local.events.create(runId, data, params);
      if (data.eventType === 'run_created' && lost < lose) {
        // Committed, but the caller never hears back.
        lost++;
        throw new WorkflowWorldError('gateway timeout', { status: 504 });
      }
      return result;
    }) as typeof local.events.create);
    setWorld({ ...local, queue, events: { ...local.events, create } } as any);
    return { local, queue, create };
  }

  it('confirms in place an admission whose response was lost', async () => {
    const { local, create } = lossyWorld(1);

    // Re-posting the same candidate learns its decision: admitted.
    const run = await stepAttempt(1, () =>
      start(workflow, ['a'], { hook: { token: TOKEN } })
    );

    const runs = await local.runs.list({});
    expect(runs.data.map((r) => r.runId)).toEqual([run.runId]);
    expect(
      create.mock.calls.filter(([, data]) => data.eventType === 'run_created')
    ).toHaveLength(2);
  });

  it('ends with exactly one run after an admission it could not confirm', async () => {
    const { local, queue } = lossyWorld(4);

    // Attempt 1: admitted, but every confirmation was lost. Retryable.
    const first = await stepAttempt(1, () =>
      start(workflow, ['a'], { hook: { token: TOKEN } })
    ).catch((e: unknown) => e);
    expect(WorkflowStartError.is(first)).toBe(true);
    expect(FatalError.is(first)).toBe(false);
    const candidate = (first as WorkflowStartError).runId;

    // Attempt 2: a new candidate, refused in favor of the first, and final.
    const second = await stepAttempt(2, () =>
      start(workflow, ['a'], { hook: { token: TOKEN } })
    ).catch((e: unknown) => e);
    expect(HookConflictError.is(second)).toBe(true);
    expect(second).toMatchObject({ conflictingRunId: candidate });
    expect(FatalError.is(second)).toBe(true);

    const runs = await local.runs.list({});
    expect(runs.data.map((run) => run.runId)).toEqual([candidate]);
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it('decides the candidate after an uncertain publish, and publishes it again', async () => {
    const local = createLocalWorld({ dataDir: dir });
    let failNextQueue = true;
    const queue = vi.fn(async () => {
      if (failNextQueue) {
        failNextQueue = false;
        throw new WorkflowWorldError('queue down', { status: 503 });
      }
      return { messageId: null };
    });
    setWorld({ ...local, queue } as any);

    const run = await stepAttempt(1, () =>
      start(workflow, [], { hook: { token: TOKEN } })
    );

    const runs = await local.runs.list({});
    expect(runs.data.map((r) => r.runId)).toEqual([run.runId]);
    expect(queue).toHaveBeenCalledTimes(2);
  });
});
