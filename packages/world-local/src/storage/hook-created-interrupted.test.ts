import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type SpecVersion,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRun } from '../test-helpers.js';
import { hookTokenClaimPath } from './helpers.js';
import { createStorage } from './index.js';

// Interrupt `hook_created` at its event publish, after the token claim and
// index entries are durable, the way a process exit mid-create leaves it.
// A fresh `createStorage` over the same directory stands in for the restart.
const interrupt = vi.hoisted(() => ({ armed: false }));
vi.mock('../fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.js')>();
  return {
    ...actual,
    writeExclusive: async (filePath: string, content: string) => {
      if (
        interrupt.armed &&
        filePath.includes(`${path.sep}events${path.sep}`) &&
        JSON.parse(content).eventType === 'hook_created'
      ) {
        throw new Error('simulated process exit before hook_created publish');
      }
      return actual.writeExclusive(filePath, content);
    },
  };
});

const hookCreated = (hookId: string, token: string) => ({
  eventType: 'hook_created' as const,
  correlationId: hookId,
  eventData: { token },
});

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hook-created-interrupted-')
  );
});
afterEach(async () => {
  interrupt.armed = false;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function startRun(specVersion?: SpecVersion) {
  return createRun(
    createStorage(dataDir),
    {
      deploymentId: 'dpl_test',
      workflowName: 'test',
      input: new Uint8Array(),
    },
    specVersion
  );
}

/** Where the run's orchestrator writes next, as it reads it from a listing. */
async function inBandAt(runId: string) {
  const { snapshot } = await createStorage(dataDir).events.list({
    runId,
    pagination: { limit: 1000 },
  });
  if (!snapshot) throw new Error(`Run ${runId} has no event log snapshot`);
  return { inBand: true as const, expectedSeqInBand: snapshot.seqInBand };
}

async function hookCreatedIds(runId: string): Promise<string[]> {
  const { data } = await createStorage(dataDir).events.list({
    runId,
    pagination: { limit: 1000 },
  });
  return data
    .filter((event) => event.eventType === 'hook_created')
    .map((event) => event.correlationId as string);
}

describe('hook_created retried after an interrupted publish', () => {
  it('creates the hook when an unrelated event took its claimed slot', async () => {
    const run = await startRun();

    interrupt.armed = true;
    await expect(
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a')
      )
    ).rejects.toThrow('simulated process exit');
    interrupt.armed = false;

    // After the restart, another writer appends first, as an inbox delivery
    // to the same run does.
    const restarted = createStorage(dataDir);
    await restarted.events.create(run.runId, {
      eventType: 'wait_created',
      correlationId: 'wait_unrelated',
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    });

    // Replay re-issues the creation. Core reads EntityConflictError as
    // "already created" and moves on, so anything but a published
    // hook_created leaves a hook the run believes it owns.
    await restarted.events.create(run.runId, hookCreated('hook_a', 'token_a'));

    expect(await hookCreatedIds(run.runId)).toEqual(['hook_a']);
    await expect(restarted.hooks.getByToken('token_a')).resolves.toMatchObject({
      hookId: 'hook_a',
    });
  });

  it('publishes one creation when two instances retry it at once', async () => {
    const run = await startRun();

    interrupt.armed = true;
    await expect(
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a')
      )
    ).rejects.toThrow('simulated process exit');
    interrupt.armed = false;

    await createStorage(dataDir).events.create(run.runId, {
      eventType: 'wait_created',
      correlationId: 'wait_unrelated',
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    });

    // Separate instances share only the directory, as two processes do.
    const retries = await Promise.allSettled([
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a')
      ),
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a')
      ),
    ]);

    expect(await hookCreatedIds(run.runId)).toEqual(['hook_a']);
    expect(
      retries.filter((result) => result.status === 'rejected')
    ).toMatchObject([{ reason: { name: 'EntityConflictError' } }]);
  });

  it('creates the hook when the orchestrator retries an in-band creation (spec 9)', async () => {
    const run = await startRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);

    interrupt.armed = true;
    await expect(
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a'),
        await inBandAt(run.runId)
      )
    ).rejects.toThrow('simulated process exit');
    interrupt.armed = false;

    // In-band writes take the fence one at a time; an out-of-band delivery
    // does not, so it can still take the claimed slot.
    const restarted = createStorage(dataDir);
    await restarted.events.create(run.runId, {
      eventType: 'wait_created',
      correlationId: 'wait_unrelated',
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    });
    await restarted.events.create(
      run.runId,
      hookCreated('hook_a', 'token_a'),
      await inBandAt(run.runId)
    );

    expect(await hookCreatedIds(run.runId)).toEqual(['hook_a']);
    await expect(restarted.hooks.getByToken('token_a')).resolves.toMatchObject({
      hookId: 'hook_a',
    });
  });

  it('does not create again a hook an older writer published past its claimed slot', async () => {
    const run = await startRun();
    const storage = createStorage(dataDir);

    // The layout a writer from before claims moved with the publish leaves:
    // it claimed slot N, lost N to another event, and published at N + 1
    // without recording it.
    const { event: unrelated } = await storage.events.create(run.runId, {
      eventType: 'wait_created',
      correlationId: 'wait_unrelated',
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    });
    await storage.events.create(run.runId, hookCreated('hook_a', 'token_a'));
    const claimPath = hookTokenClaimPath(dataDir, 'token_a');
    const claim = JSON.parse(await fs.readFile(claimPath, 'utf8'));
    await fs.writeFile(
      claimPath,
      JSON.stringify({ ...claim, eventId: unrelated?.eventId })
    );

    await expect(
      createStorage(dataDir).events.create(
        run.runId,
        hookCreated('hook_a', 'token_a')
      )
    ).rejects.toMatchObject({ name: 'EntityConflictError' });

    expect(await hookCreatedIds(run.runId)).toEqual(['hook_a']);
    await expect(
      createStorage(dataDir).hooks.getByToken('token_a')
    ).resolves.toMatchObject({ hookId: 'hook_a' });
  });

  it('creates every hook of a batch interrupted before any publish', async () => {
    const run = await startRun();

    // Concurrent creates draw the same candidate slot, so both claims name it.
    interrupt.armed = true;
    const owner = createStorage(dataDir);
    const interrupted = await Promise.allSettled([
      owner.events.create(run.runId, hookCreated('hook_a', 'token_a')),
      owner.events.create(run.runId, hookCreated('hook_b', 'token_b')),
    ]);
    expect(interrupted.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    interrupt.armed = false;

    const restarted = createStorage(dataDir);
    await Promise.allSettled([
      restarted.events.create(run.runId, hookCreated('hook_a', 'token_a')),
      restarted.events.create(run.runId, hookCreated('hook_b', 'token_b')),
    ]);

    expect((await hookCreatedIds(run.runId)).sort()).toEqual([
      'hook_a',
      'hook_b',
    ]);
    await expect(restarted.hooks.getByToken('token_b')).resolves.toMatchObject({
      hookId: 'hook_b',
    });
  });
});
