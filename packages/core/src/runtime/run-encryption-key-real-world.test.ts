/**
 * `Run#getReadable()` key resolution end to end over a real World (#4645).
 *
 * The sibling `run-encryption-key-resolve-data.test.ts` pins the call shape on
 * a mocked World. This composes the real pieces instead: world-local storage
 * and streams, with world-vercel's real `getEncryptionKeyForRun` attached, so
 * it shows that a metadata-only run read still carries the `deploymentId` the
 * key lookup routes on, and that a stream written under the run's key still
 * decrypts through the `(runId, { deploymentId })` overload.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { createGetEncryptionKeyForRun } from '@workflow/world-vercel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { getRun } from './run.js';
import { setWorld } from './world.js';

const LOCAL_DEPLOYMENT_ID = 'dpl_local';
const RUN_KEY_URL = 'https://api.vercel.com/v1/workflow/run-key/';
const ENV_KEYS = [
  'VERCEL',
  'VERCEL_DEPLOYMENT_ID',
  'VERCEL_DEPLOYMENT_KEY',
] as const;

describe('Run#getReadable() key resolution over a real World', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  let dir: string;
  let world: World;

  beforeEach(async () => {
    // Inside a Vercel Function: same-deployment keys derive locally, and
    // cross-deployment keys are fetched from the API.
    process.env.VERCEL = '1';
    process.env.VERCEL_DEPLOYMENT_ID = LOCAL_DEPLOYMENT_ID;
    process.env.VERCEL_DEPLOYMENT_KEY = Buffer.alloc(32, 9).toString('base64');
    dir = await mkdtemp(join(tmpdir(), 'run-key-real-world-'));
    world = Object.assign(createWorld({ dataDir: dir }) as unknown as World, {
      getEncryptionKeyForRun: createGetEncryptionKeyForRun(
        'prj_test',
        'team_test',
        'token_test',
        // Any dispatcher keeps the key fetch on global `fetch`, stubbed below.
        {}
      ),
    });
    setWorld(world);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    setWorld(undefined as unknown as World);
    await rm(dir, { recursive: true, force: true });
  });

  /** A running run whose input is large enough that resolving it is the cost. */
  async function startRun(deploymentId: string): Promise<string> {
    const created = await world.events.create(
      null as never,
      {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId,
          workflowName: 'run-key-real-world',
          input: new Uint8Array(5_000_000),
        },
      } as never
    );
    const runId = created.run?.runId;
    if (!runId) throw new Error('expected the run to be created');
    await world.events.create(
      runId as never,
      { eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT } as never
    );
    return runId;
  }

  async function write(runId: string, values: unknown[]): Promise<void> {
    const ops: Promise<void>[] = [];
    const writer = getRun(runId).getWritable({ ops }).getWriter();
    for (const value of values) await writer.write(value);
    await writer.close();
    await Promise.all(ops);
  }

  /** Read through a fresh handle, the `getRun(id).getReadable()` shape. */
  async function read(runId: string): Promise<unknown[]> {
    const values: unknown[] = [];
    const reader = getRun(runId).getReadable().getReader();
    for (;;) {
      const result = await reader.read();
      if (result.done) return values;
      values.push(result.value);
    }
  }

  /** The 4-byte format tag of every frame the stream stored. */
  async function storedFrameTags(runId: string): Promise<string[]> {
    const [name] = await world.streams.list(runId);
    const reader = (await world.streams.get(runId, name, 0)).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    const bytes = Buffer.concat(chunks);
    const tags: string[] = [];
    for (let i = 0; i + 8 <= bytes.length; i += 4 + bytes.readUInt32BE(i)) {
      tags.push(bytes.subarray(i + 4, i + 8).toString());
    }
    return tags;
  }

  it('decrypts a same-deployment stream after a metadata-only run read', async () => {
    const runId = await startRun(LOCAL_DEPLOYMENT_ID);
    await write(runId, ['a', { b: 2 }, [3]]);
    // The frames really are encrypted, so the read below needs the key.
    expect(await storedFrameTags(runId)).toEqual(['encr', 'encr', 'encr']);

    const runsGet = vi.spyOn(world.runs, 'get');
    expect(await read(runId)).toEqual(['a', { b: 2 }, [3]]);
    expect(runsGet.mock.calls.map(([, params]) => params)).toEqual([
      { resolveData: 'none' },
    ]);
  });

  it("fetches a cross-deployment key from the run's own deployment", async () => {
    const runId = await startRun('dpl_other');
    const keyUrls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith(RUN_KEY_URL)) return realFetch(input, init);
      keyUrls.push(url);
      return Response.json({ key: Buffer.alloc(32, 3).toString('base64') });
    });
    await write(runId, ['x', 'y']);
    keyUrls.length = 0;

    const runsGet = vi.spyOn(world.runs, 'get');
    expect(await read(runId)).toEqual(['x', 'y']);
    expect(runsGet.mock.calls.map(([, params]) => params)).toEqual([
      { resolveData: 'none' },
    ]);
    // The deploymentId from the metadata-only read is what the lookup used.
    expect(keyUrls).toHaveLength(1);
    expect(keyUrls[0]).toContain(`${RUN_KEY_URL}dpl_other?`);
  });
});
