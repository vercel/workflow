import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { dehydrateWorkflowReturnValue } from '../serialization.js';
import { getRun } from './run.js';
import { setWorld } from './world.js';

/**
 * `await run.returnValue` end to end over a real World.
 *
 * The sibling `run-return-value-long-poll.test.ts` pins the *pacing* against a
 * mocked `runs` on fake timers, and each World's own suite exercises
 * `waitForTerminalStatus` directly. Neither covers them composed: the real
 * `isReturnValueLongPollEnabled()` gate, the real bound method, a real World,
 * and the interval floor, on a real clock.
 *
 * So these assert the property a user actually observes — how long after the
 * run finishes the await resolves — with world-local standing in for "a World
 * that can wait". A run finishing 300ms in can only be reported at the ~1s
 * tick by interval polling, so the two paths are far apart and the kill switch
 * is observable rather than merely configured.
 */
describe('run.returnValue over a real World', () => {
  const envName = 'WORKFLOW_RETURN_VALUE_LONG_POLL';
  const original = process.env[envName];
  let dir: string;
  let world: World;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'returnvalue-real-world-'));
    world = createWorld({ dataDir: dir }) as unknown as World;
    setWorld(world);
  });

  afterEach(async () => {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
    setWorld(undefined as unknown as World);
    await rm(dir, { recursive: true, force: true });
  });

  /** A run in `running`, created through the event log like a real one. */
  async function startRun(): Promise<string> {
    const created = await world.events.create(null as never, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'return-value-real-world',
        input: new Uint8Array([1]),
      },
    } as never);
    const runId = created.run?.runId;
    if (!runId) throw new Error('expected the run to be created');
    await world.events.create(runId as never, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    } as never);
    return runId;
  }

  /** Finish the run after `ms`, the way a workflow completing elsewhere would. */
  function completeAfter(runId: string, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        dehydrateWorkflowReturnValue('done', runId)
          .then((output) =>
            world.events.create(runId as never, {
              eventType: 'run_completed',
              specVersion: SPEC_VERSION_CURRENT,
              eventData: { output },
            } as never)
          )
          .then(resolve, reject);
      }, ms);
    });
  }

  it('resolves as soon as the run finishes, not at the next poll tick', async () => {
    const runId = await startRun();

    const startedAt = Date.now();
    const pending = getRun<string>(runId).returnValue;
    const finishing = completeAfter(runId, 300);

    await expect(pending).resolves.toBe('done');
    const elapsed = Date.now() - startedAt;
    await finishing;

    // At or above the 1s interval would mean the poll reported it, not the wait.
    expect(elapsed).toBeLessThan(800);
  }, 30_000);

  it('reports a cancellation without waiting out the interval', async () => {
    const runId = await startRun();

    const startedAt = Date.now();
    const pending = getRun<string>(runId).returnValue;
    const cancelling = new Promise((resolve, reject) => {
      setTimeout(() => {
        world.events
          .create(runId as never, {
            eventType: 'run_cancelled',
            specVersion: SPEC_VERSION_CURRENT,
          } as never)
          .then(resolve, reject);
      }, 300);
    });

    await expect(pending).rejects.toThrow();
    const elapsed = Date.now() - startedAt;
    await cancelling;

    expect(elapsed).toBeLessThan(800);
  }, 30_000);

  it('restores fixed-interval polling under the kill switch', async () => {
    process.env[envName] = '0';
    const runId = await startRun();

    const startedAt = Date.now();
    const pending = getRun<string>(runId).returnValue;
    const finishing = completeAfter(runId, 300);

    await expect(pending).resolves.toBe('done');
    const elapsed = Date.now() - startedAt;
    await finishing;

    // The run was done at ~300ms, but only the ~1s tick can observe it.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 30_000);
});
