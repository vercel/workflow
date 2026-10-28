import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRunCancelledError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { dehydrateWorkflowReturnValue } from '../serialization.js';
import { getRun } from './run.js';
import { setWorld } from './world.js';

// Only bounds how long a test waits for the first read to start; nothing is
// asserted about how quickly it does.
const WAIT_FOR_READ = { timeout: 10_000 };

/**
 * `await run.returnValue` end to end over a real World.
 *
 * The sibling `run-return-value-long-poll.test.ts` pins the *pacing* against a
 * mocked `runs` on fake timers, and each World's own suite exercises
 * `waitForTerminalStatus` directly. Neither covers them composed: the real
 * `isReturnValueLongPollEnabled()` gate, the real bound method, and a real
 * World.
 *
 * So these assert which path reported the terminal status, with world-local
 * standing in for "a World that can wait": the long poll is one
 * `waitForTerminalStatus` call that is already in flight when the run
 * finishes, and interval polling is repeated metadata-only `runs.get` reads.
 * The run is finished only once the first read is under way, so neither
 * outcome depends on how fast the runner is.
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
    vi.restoreAllMocks();
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
    setWorld(undefined as unknown as World);
    await rm(dir, { recursive: true, force: true });
  });

  /** A run in `running`, created through the event log like a real one. */
  async function startRun(): Promise<string> {
    const created = await world.events.create(
      null as never,
      {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'return-value-real-world',
          input: new Uint8Array([1]),
        },
      } as never
    );
    const runId = created.run?.runId;
    if (!runId) throw new Error('expected the run to be created');
    await world.events.create(
      runId as never,
      {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      } as never
    );
    return runId;
  }

  /** Finish the run, the way a workflow completing elsewhere would. */
  async function complete(runId: string): Promise<void> {
    const output = await dehydrateWorkflowReturnValue('done', runId);
    await world.events.create(
      runId as never,
      {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { output },
      } as never
    );
  }

  async function cancel(runId: string): Promise<void> {
    await world.events.create(
      runId as never,
      { eventType: 'run_cancelled', specVersion: SPEC_VERSION_CURRENT } as never
    );
  }

  /**
   * Spies on both read paths. The long poll is `runs.waitForTerminalStatus`;
   * interval polling is `runs.get` with `resolveData: 'none'` (the payload read
   * after a terminal status uses `'all'`).
   */
  function spyOnReads() {
    const wait = vi.spyOn(world.runs, 'waitForTerminalStatus' as never);
    const get = vi.spyOn(world.runs, 'get');
    const metadataReads = () =>
      get.mock.calls.flatMap(([, params], index) =>
        params?.resolveData === 'none' ? [get.mock.results[index]] : []
      );
    return { wait, metadataReads };
  }

  it('reports completion from the in-flight long poll', async () => {
    const runId = await startRun();
    const { wait, metadataReads } = spyOnReads();

    const pending = getRun<string>(runId).returnValue;
    await vi.waitFor(() => expect(wait).toHaveBeenCalled(), WAIT_FOR_READ);
    await complete(runId);

    await expect(pending).resolves.toBe('done');
    expect(wait).toHaveBeenCalledOnce();
    expect(metadataReads()).toHaveLength(0);
  });

  it('reports a cancellation from the in-flight long poll', async () => {
    const runId = await startRun();
    const { wait, metadataReads } = spyOnReads();

    const outcome = expect(
      getRun<string>(runId).returnValue
    ).rejects.toBeInstanceOf(WorkflowRunCancelledError);
    await vi.waitFor(() => expect(wait).toHaveBeenCalled(), WAIT_FOR_READ);
    await cancel(runId);

    await outcome;
    expect(wait).toHaveBeenCalledOnce();
    expect(metadataReads()).toHaveLength(0);
  });

  it('restores fixed-interval polling under the kill switch', async () => {
    process.env[envName] = '0';
    const runId = await startRun();
    const { wait, metadataReads } = spyOnReads();

    const pending = getRun<string>(runId).returnValue;
    // Let the first poll observe the run still running before finishing it,
    // so only a later tick can report it.
    await vi.waitFor(
      () => expect(metadataReads()).toHaveLength(1),
      WAIT_FOR_READ
    );
    await metadataReads()[0]?.value;
    await complete(runId);

    await expect(pending).resolves.toBe('done');
    expect(wait).not.toHaveBeenCalled();
    expect(metadataReads().length).toBeGreaterThanOrEqual(2);
  });
});
