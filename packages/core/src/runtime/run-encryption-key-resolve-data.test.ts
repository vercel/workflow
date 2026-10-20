/**
 * Regression coverage for #4645.
 *
 * `getEncryptionKeyForRun` reads only a run's `runId` and `deploymentId`, both
 * of which survive `resolveData: 'none'`. The two call sites that have to read
 * the run themselves used to fetch it with the default (`'all'`), which
 * world-vercel maps to `remoteRefBehavior=resolve` — the server resolves and
 * returns the run's entire input and output before the caller can read a byte
 * of the stream, and `Run#getReadable()` pays it per handle.
 */
import {
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { getForwardedWritableEncryptionKey } from '../serialization.js';
import { Run } from './run.js';
import { setWorld } from './world.js';

const RUN_ID = 'wrun_4645';
const DEPLOYMENT_ID = 'dpl_1';

/** A run whose payload is large enough that resolving it is the cost. */
function makeRun(): WorkflowRun {
  return {
    runId: RUN_ID,
    workflowName: 'wf',
    status: 'running',
    specVersion: SPEC_VERSION_CURRENT,
    deploymentId: DEPLOYMENT_ID,
    input: new Uint8Array(5_000_000),
    attributes: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
  } as WorkflowRun;
}

function createWorld({ encryption = true }: { encryption?: boolean } = {}) {
  const run = makeRun();
  /** Every `runs.get` options object this World was handed, in order. */
  const getCalls: (Record<string, unknown> | undefined)[] = [];
  const getEncryptionKeyForRun = vi.fn(async () => new Uint8Array(32).fill(7));
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: vi.fn(async (_id: string, params?: Record<string, unknown>) => {
        getCalls.push(params);
        return params?.resolveData === 'none'
          ? ({ ...run, input: undefined, output: undefined } as WorkflowRun)
          : run;
      }),
    },
    ...(encryption ? { getEncryptionKeyForRun } : {}),
    streams: {
      // Never resolves: the key lookup is what is under test, and it runs
      // concurrently with the stream GET.
      get: vi.fn(() => new Promise<never>(() => {})),
      getInfo: vi.fn(async () => ({ tailIndex: 0 })),
    },
  } as unknown as World;
  return { world, getCalls, getEncryptionKeyForRun };
}

/** Consume a readable far enough to trigger the key prefetch on first pull. */
async function pullOnce(readable: ReadableStream) {
  const reader = readable.getReader();
  reader.read().catch(() => {});
  return () => reader.cancel().catch(() => {});
}

describe('#4645 encryption-key lookups do not resolve run payloads', () => {
  it("Run#getReadable() reads the run with resolveData: 'none'", async () => {
    const { world, getCalls, getEncryptionKeyForRun } = createWorld();
    setWorld(world);

    const cancel = await pullOnce(new Run(RUN_ID).getReadable());
    await vi.waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
    await cancel();

    expect(getCalls).toEqual([{ resolveData: 'none' }]);
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(RUN_ID, {
      deploymentId: DEPLOYMENT_ID,
    });
  });

  it('Run#getReadable() reads no run at all when the World cannot encrypt', async () => {
    const { world, getCalls } = createWorld({ encryption: false });
    setWorld(world);

    const cancel = await pullOnce(new Run(RUN_ID).getReadable());
    // Give the prefetch a turn of the loop to do the wrong thing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cancel();

    expect(getCalls).toEqual([]);
  });

  it("getForwardedWritableEncryptionKey() falls back with resolveData: 'none'", async () => {
    const { world, getCalls, getEncryptionKeyForRun } = createWorld();
    setWorld(world);

    // No deploymentId and no public key: the legacy descriptor shape that
    // takes the `runs.get` fallback.
    await getForwardedWritableEncryptionKey(RUN_ID, undefined, undefined);

    expect(getCalls).toEqual([{ resolveData: 'none' }]);
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(RUN_ID, {
      deploymentId: DEPLOYMENT_ID,
    });
  });

  it('getForwardedWritableEncryptionKey() reads no run when it has a deploymentId', async () => {
    const { world, getCalls, getEncryptionKeyForRun } = createWorld();
    setWorld(world);

    await getForwardedWritableEncryptionKey(RUN_ID, 'dpl_other', undefined);

    expect(getCalls).toEqual([]);
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(RUN_ID, {
      deploymentId: 'dpl_other',
    });
  });
});
